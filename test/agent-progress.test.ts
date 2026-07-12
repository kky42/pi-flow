import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { getSubagentProfiles, loadBuiltinSubagentProfiles } from "../src/profiles.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeError, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../src/core/spawn.ts";
import { packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pi-subagent progress and status", () => {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;
  let registrations: Array<{ unregister: () => void }> = [];

  const {
    trackSession,
    disposeSession,
    createSession,
    delegateOnce,
    makeMockTheme,
    stripAnsi,
    renderToText,
    formatTestTokens,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
    registrations = state.registrations;
  });
  it("does not emit progress updates when no interactive UI is bound", async () => {
    const { session, registration } = await createSession();
    const updateEvents: unknown[] = [];

    session.subscribe((event) => {
      if (event.type === "tool_execution_update") {
        updateEvents.push(event);
      }
    });

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Research config",
        prompt: "Inspect config loading.",
      })], { stopReason: "toolUse" }),
      fauxAssistantMessage("config found"),
      fauxAssistantMessage("done"),
    ]);

    await session.prompt("Delegate config research.");

    expect(updateEvents).toEqual([]);

    disposeSession(session);
  });

  it("does not emit compact UI progress updates in RPC mode", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const updateEvents: unknown[] = [];

    registration.setResponses([
      fauxAssistantMessage("config found"),
    ]);

    await tool.execute(
      "rpc-agent-call",
      {
        description: "Research config",
        prompt: "Inspect config loading.",
      },
      undefined,
      (result: unknown) => updateEvents.push(result),
      makeExecutionContext({ hasUI: true, model, modelRegistry }),
    );

    expect(updateEvents).toEqual([]);

    disposeSession(session);
  });

  it("does not start the child prompt when the tool signal is already aborted", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const controller = new AbortController();
    let childContext: Context | undefined;

    registration.setResponses([
      (context) => {
        childContext = context;
        return fauxAssistantMessage("should not run");
      },
    ]);

    controller.abort();

    const result = await tool.execute(
      "pre-aborted-agent-call",
      {
        description: "Research config",
        prompt: "Inspect config loading.",
      },
      controller.signal,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(result.details.status).toBe("aborted");
    expect(result.details.backend).toBe("pi");
    expect(result.details.error).toContain("Aborted while waiting for a concurrency slot");
    expect(childContext).toBeUndefined();
    expect(registration.getPendingResponseCount()).toBe(1);

    disposeSession(session);
  });

  it("marks a pi subagent aborted when the signal aborts inside spawn", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const profile = getSubagentProfiles(agentDir).get("general-purpose");
    expect(profile).toBeDefined();
    const controller = new AbortController();
    const progressUpdates: any[] = [];
    let usageUpdates = 0;

    registration.setResponses([fauxAssistantMessage("should not run")]);
    controller.abort();

    const result = await spawnSubagent({
      toolCallId: "spawn-aborted-agent-call",
      description: "Research config",
      prompt: "Inspect config loading.",
      profile: profile!,
      model,
      thinkingLevel: "high",
      ctx: makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext,
      signal: controller.signal,
      timeoutMs: 0,
      progressEnabled: true,
      onProgress: (partial) => progressUpdates.push(partial),
      onUsage: () => {
        usageUpdates++;
      },
      excludeTools: CHILD_EXCLUDED_TOOLS,
    });

    expect(result.details.status).toBe("aborted");
    expect(result.details.progress?.status).toBe("aborted");
    expect(result.details.error).toContain("Subagent aborted before prompt start");
    expect(progressUpdates).toEqual([]);
    expect(usageUpdates).toBe(1);
    expect(registration.getPendingResponseCount()).toBe(1);

    disposeSession(session);
  });

  it("marks a pi subagent error when the final turn ends with stopReason error", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const profile = getSubagentProfiles(agentDir).get("general-purpose");
    expect(profile).toBeDefined();
    const progressUpdates: any[] = [];
    let usageUpdates = 0;

    // pi-ai never throws for model/request failures (e.g. a rate-limit / quota
    // hit). It resolves the turn with stopReason "error" and an errorMessage, so
    // a backend that only treats a thrown prompt() as failure would mark this
    // hollow turn "done". The subagent must report it as an error instead.
    //
    // pi's AgentSession retries a stopReason-"error" turn (default maxRetries: 3,
    // baseDelayMs: 2000) before giving up. Disable retry for this subagent
    // session so the single injected error turn is terminal — keeping the test
    // fast and deterministic. spawnSubagent reads settings from agentDir on disk
    // via SettingsManager.create.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    registration.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded (429)" }),
    ]);

    const result = await spawnSubagent({
      toolCallId: "spawn-error-stop-reason",
      description: "Research config",
      prompt: "Inspect config loading.",
      profile: profile!,
      model,
      thinkingLevel: "high",
      ctx: makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext,
      signal: undefined,
      timeoutMs: 0,
      progressEnabled: true,
      onProgress: (partial) => progressUpdates.push(partial),
      onUsage: () => {
        usageUpdates++;
      },
      excludeTools: CHILD_EXCLUDED_TOOLS,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("rate limit exceeded");
    expect(result.details.progress?.status).toBe("error");
    expect(result.details.result).toBeUndefined();
    expect(result.content[0].text).toContain("rate limit exceeded");
    expect(usageUpdates).toBeGreaterThan(0);
    // Exactly one provider call: retry is disabled, so the injected error turn
    // is terminal (no retries drained the queue).
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("reports a provider-side stopReason aborted (no signal abort) as an error, not aborted", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const profile = getSubagentProfiles(agentDir).get("general-purpose");
    expect(profile).toBeDefined();

    // A terminal "aborted" turn that WE did not trigger (the spawn signal never
    // aborts). spawnSubagent derives status from signal?.aborted, so this is
    // reported as an error. With no errorMessage, the synthesized message must
    // stay status-neutral: framed as a failure, with the stopReason only as a
    // diagnostic detail — never claiming the run was "aborted".
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    registration.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);

    const result = await spawnSubagent({
      toolCallId: "spawn-provider-aborted",
      description: "Research config",
      prompt: "Inspect config loading.",
      profile: profile!,
      model,
      thinkingLevel: "high",
      ctx: makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext,
      signal: undefined,
      timeoutMs: 0,
      progressEnabled: true,
      onProgress: () => {},
      onUsage: () => {},
      excludeTools: CHILD_EXCLUDED_TOOLS,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.progress?.status).toBe("error");
    // stopReason retained as a diagnostic detail, but framed as a failure that
    // matches the "error" status rather than asserting an abort.
    expect(result.details.error).toContain("stopReason: aborted");
    expect(result.content[0].text).toContain("failed:");
    expect(result.content[0].text).not.toContain("aborted:");

    disposeSession(session);
  });

  it("reports a configured direct subagent timeout as a timeout", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ subagentTimeoutMs: 20 });
    const tool = session.getToolDefinition("Agent") as any;

    registration.setResponses([
      async () => {
        await delay(80);
        return fauxAssistantMessage("late child output");
      },
    ]);

    const result = await tool.execute(
      "timeout-agent-call",
      {
        description: "Slow child",
        prompt: "Take too long.",
      },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(result.details.status).toBe("aborted");
    expect(result.details.error).toContain("Subagent timed out after 20ms");
    expect(result.details.result).toBeUndefined();
    expect(result.content[0].text).toContain("timed out after 20ms");

    disposeSession(session);
  });

  it("does not rewrite an external abort as a timeout when both signals race", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ subagentTimeoutMs: 20 });
    const tool = session.getToolDefinition("Agent") as any;
    const controller = new AbortController();

    registration.setResponses([
      async () => {
        await delay(80);
        return fauxAssistantMessage("late child output");
      },
    ]);

    const pending = tool.execute(
      "external-abort-agent-call",
      {
        description: "Externally aborted child",
        prompt: "Wait until aborted.",
      },
      controller.signal,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    setTimeout(() => controller.abort(), 5).unref?.();

    const result = await pending;

    expect(result.details.error ?? "").not.toContain("timed out");
    expect(result.content[0].text).not.toContain("timed out");

    disposeSession(session);
  });

  it("keeps same-description root parallel progress nodes separate", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;

    registration.setResponses([
      fauxAssistantMessage("first root child done"),
    ]);

    const result = await tool.execute(
      "root-progress-a",
      {
        description: "Same audit",
        prompt: "First root task.",
      },
      undefined,
      () => {},
      makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }),
    );

    expect(result.details.backend).toBe("pi");
    expect(result.details.progress?.id).toBe("root-progress-a");
    expect(result.details.progress?.description).toBe("Same audit");
    expect(result.details.progress?.backend).toBe("pi");
    expect(result.details.usage?.input).toBeGreaterThan(0);
    expect(result.details.usage?.output).toBeGreaterThan(0);
    expect(result.details.progress?.usage).toEqual(result.details.usage);

    disposeSession(session);
  });

  it("updates a cumulative pi-flow status line from child usage", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onStatus: (key, text) => statuses.push({ key, text }),
    });

    registration.setResponses([
      fauxAssistantMessage("first child done"),
      fauxAssistantMessage("second child done"),
    ]);

    const first = await tool.execute(
      "usage-status-a",
      {
        description: "First child",
        prompt: "First child task.",
      },
      undefined,
      undefined,
      context,
    );
    const second = await tool.execute(
      "usage-status-b",
      {
        description: "Second child",
        prompt: "Second child task.",
      },
      undefined,
      undefined,
      context,
    );

    const final = statuses.filter((status) => status.key === "pi-flow").at(-1)?.text ?? "";
    const usage = {
      input: first.details.usage.input + second.details.usage.input,
      output: first.details.usage.output + second.details.usage.output,
      cacheRead: first.details.usage.cacheRead + second.details.usage.cacheRead,
      cacheWrite: first.details.usage.cacheWrite + second.details.usage.cacheWrite,
      cost: first.details.usage.cost + second.details.usage.cost,
      latestCacheHitRate: undefined as number | undefined,
    };
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    usage.latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
    const expected = `pi-flow ↑${formatTestTokens(usage.input)} ↓${formatTestTokens(usage.output)}`;

    expect(statuses.some((status) => status.key === "pi-flow" && status.text)).toBe(true);
    expect(final).toContain(expected);
    if (usage.cacheRead) {
      expect(final).toContain(`R${formatTestTokens(usage.cacheRead)}`);
    }
    if (usage.cacheWrite) {
      expect(final).toContain(`W${formatTestTokens(usage.cacheWrite)}`);
    }
    if (usage.latestCacheHitRate !== undefined) {
      expect(final).toContain(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
    }

    disposeSession(session);
  });
});
