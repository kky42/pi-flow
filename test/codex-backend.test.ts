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
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, extractCodexSessionId, extractCodexUsage, spawnCodexSubagent } from "../src/core/codex.ts";
import { MAX_STDOUT_LINE_CHARS } from "../src/core/stream.ts";
import { packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent codex backend", () => {
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
  it("builds codex args and estimates listed-model costs", () => {
    const args = buildCodexArgs({
      prompt: "Do the task.",
      thinkingLevel: "xhigh",
      profile: {
        name: "codex-reviewer",
        description: "Codex reviewer",
        backend: "codex",
        model: "gpt-5.4-mini",
        systemPrompt: "You are a Codex reviewer.",
      },
      outputSchemaPath: "/tmp/schema.json",
    });

    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-c",
      "developer_instructions=\"You are a Codex reviewer.\"",
      "--model",
      "gpt-5.4-mini",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "--output-schema",
      "/tmp/schema.json",
      "--",
      "-",
    ]);

    expect(buildCodexArgs({
      prompt: "Revise.",
      thinkingLevel: undefined,
      sessionId: "codex-session-1",
      persistSession: true,
      profile: {
        name: "codex-reviewer",
        description: "Codex reviewer",
        backend: "codex",
      },
    })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "codex-session-1",
      "-",
    ]);

    const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 0 };
    expect(estimateCodexCostUsd("openai/gpt-5.4-mini", usage)).toBeCloseTo(0.000305);
    expect(estimateCodexCostUsd("gpt-5.6-sol", usage)).toBeCloseTo(0.0056);
    expect(estimateCodexCostUsd("openai-codex/gpt-5.6-terra", usage)).toBeCloseTo(0.0028);
    expect(estimateCodexCostUsd("gpt-5.6-luna", usage)).toBeCloseTo(0.00112);
    expect(estimateCodexCostUsd("gpt-5.6-sol", {
      ...usage,
      inputTokens: 272_001,
    })).toBeCloseTo(1.3606);
    expect(estimateCodexCostUsd("unknown-model", usage)).toBeUndefined();
    expect(codexUsageToSubagentUsage("unknown-model", usage)).toMatchObject({
      input: 800,
      cacheRead: 200,
      output: 50,
      cost: 0,
      costKnown: false,
    });
  });

  it("prefers cumulative usage from codex token-count snapshots", () => {
    expect(extractCodexUsage({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 900,
            output_tokens: 40,
            reasoning_output_tokens: 10,
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 900,
            output_tokens: 20,
            reasoning_output_tokens: 10,
          },
        },
      },
    })).toEqual({
      inputTokens: 2000,
      cachedInputTokens: 900,
      outputTokens: 40,
      reasoningOutputTokens: 10,
    });
  });

  it("extracts codex session id and final text", () => {
    expect(extractCodexSessionId({ type: "thread.started", thread_id: "codex-thread-123" })).toBe("codex-thread-123");
    expect(extractCodexSessionId({ type: "thread.started", session_id: "codex-session-123" })).toBe("codex-session-123");
    expect(extractCodexSessionId({ type: "item.completed" })).toBeUndefined();
    expect(extractCodexFinalText({
      type: "item.completed",
      item: { type: "agent_message", text: "text field" },
    })).toBe("text field");
    expect(extractCodexFinalText({
      type: "item.completed",
      item: { type: "agent_message", message: "message field" },
    })).toBe("message field");
    expect(extractCodexFinalText({
      type: "item.completed",
      item: { type: "agent_message", structured_content: { ok: true, text: "keep-json" } },
    })).toBe(JSON.stringify({ ok: true, text: "keep-json" }));
  });

  it("runs a codex-backed subagent through the Agent tool", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin");
    const argsPath = join(tempDir, "codex-args.json");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-reviewer.md"), `---
description: Reviews through Codex CLI.
backend: codex
model: gpt-5.4-mini
thinking: low
---

Codex reviewer prompt.`);
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-test-session' }));
console.log(JSON.stringify({ type: 'error', message: 'transient reconnecting 1/5' }));
console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'rg TODO' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'rg TODO' } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex child done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Codex review",
        subagent_type: "codex-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to Codex.");

    const codexRun = JSON.parse(readFileSync(argsPath, "utf8"));
    const codexArgs = codexRun.args;
    expect(codexArgs).toContain("exec");
    expect(codexArgs).toContain("--json");
    expect(codexArgs).toContain("--model");
    expect(codexArgs).toContain("gpt-5.4-mini");
    expect(codexArgs).toContain("developer_instructions=\"Codex reviewer prompt.\"");
    expect(codexArgs).toContain("--ephemeral");
    expect(codexArgs.at(-1)).toBe("-");
    expect(codexRun.stdin).toBe("Review the latest diff.");
    const rootMessages = JSON.stringify(rootContinuationContext?.messages);
    expect(rootMessages).toContain("codex child done");
    expect(rootMessages).not.toContain("session_id:");

    disposeSession(session);
  });

  it("returns codex thread ids and uses session_id with exec resume", async () => {
    const binDir = join(tempDir, "bin-codex-resume");
    const runsPath = join(tempDir, "codex-runs.jsonl");
    mkdirSync(binDir, { recursive: true });
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(runsPath)}, JSON.stringify({ args, stdin }) + '\\n');
const resumeIndex = args.indexOf('resume');
const sessionId = resumeIndex === -1 ? 'codex-first-session' : args[args.length - 2];
console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: stdin.includes('Second') ? 'second done' : 'first done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const profile = {
      name: "codex-resume",
      description: "Codex resume profile.",
      backend: "codex" as const,
      model: "gpt-5.4-mini",
      systemPrompt: "Codex resume prompt.",
    };
    const first = await spawnCodexSubagent({
      toolCallId: "codex-resume-1",
      description: "Codex first",
      prompt: "First prompt.",
      profile,
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      persistSession: true,
    });
    expect(first.details.sessionId).toBe("codex-first-session");

    const second = await spawnCodexSubagent({
      toolCallId: "codex-resume-2",
      description: "Codex second",
      prompt: "Second prompt.",
      profile,
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      sessionId: String(first.details.sessionId),
      persistSession: true,
    });

    expect(second.details.sessionId).toBe("codex-first-session");
    const runs = readFileSync(runsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(runs[0].args).not.toContain("resume");
    expect(runs[1].args).toContain("resume");
    expect(runs[1].args).toContain("codex-first-session");
    expect(runs[1].stdin).toBe("Second prompt.");
  });

  it("subtracts resumed-session usage from cumulative token snapshots", async () => {
    const binDir = join(tempDir, "bin-codex-resume-usage");
    mkdirSync(binDir, { recursive: true });
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-existing-session' }));
console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 60, reasoning_output_tokens: 0 },
  last_token_usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 0 }
} } }));
console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: 1500, cached_input_tokens: 1100, output_tokens: 80, reasoning_output_tokens: 0 },
  last_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 20, reasoning_output_tokens: 0 }
} } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'resumed usage done' } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnCodexSubagent({
      toolCallId: "codex-resume-usage",
      description: "Codex resumed usage",
      prompt: "Continue.",
      profile: {
        name: "codex-resume-usage",
        description: "Codex resumed usage profile.",
        backend: "codex",
        model: "gpt-5.4-mini",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      sessionId: "codex-existing-session",
      persistSession: true,
    });

    expect(result.details.status).toBe("done");
    expect(result.details.usage).toMatchObject({
      input: 200,
      cacheRead: 300,
      output: 30,
      cacheHitRate: 60,
    });
  });

  it("kills a codex child if abort lands after process spawn", async () => {
    const binDir = join(tempDir, "bin-abort-race");
    const markerPath = join(tempDir, "codex-child-completed");
    mkdirSync(binDir, { recursive: true });
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.stdin.resume();
setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'completed');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-abort-race' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'should not complete' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
}, 700);
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    let abortedChecks = 0;
    const signal = {
      get aborted() {
        abortedChecks += 1;
        return abortedChecks >= 3;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    const result = await spawnCodexSubagent({
      toolCallId: "codex-abort-race",
      description: "Codex abort race",
      prompt: "This should be aborted before stdin is sent.",
      profile: {
        name: "codex-race",
        description: "Codex abort race profile.",
        backend: "codex",
        model: "gpt-5.4-mini",
        systemPrompt: "Codex race prompt.",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("aborted");
    expect(result.details.backend).toBe("codex");
    expect(result.details.error).toContain("aborted before prompt start");
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(markerPath)).toBe(false);
  });

  it("fails clearly when codex emits an oversized stdout line", async () => {
    const binDir = join(tempDir, "bin-codex-oversize");
    mkdirSync(binDir, { recursive: true });
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdout.write('x'.repeat(${MAX_STDOUT_LINE_CHARS + 1024}), () => {
  setTimeout(() => process.exit(0), 50);
});
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnCodexSubagent({
      toolCallId: "codex-oversize",
      description: "Codex oversize",
      prompt: "Trigger oversize stdout.",
      profile: {
        name: "codex-oversize",
        description: "Codex oversize profile.",
        backend: "codex",
        model: "gpt-5.4-mini",
        systemPrompt: "Codex oversize prompt.",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("codex emitted a stdout line over");
    expect(result.details.error).toContain("without a newline");
  });

  it("renders priced Codex usage above 272K in the Agent status line", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-tiered-cost");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-tiered.md"), `---
description: Uses tiered Codex pricing.
backend: codex
model: gpt-5.6-sol
---
`);
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-tiered-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'tiered model done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 272001, cached_input_tokens: 200, output_tokens: 50 } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const result = await tool.execute(
      "codex-tiered-cost",
      {
        description: "Tiered cost",
        subagent_type: "codex-tiered",
        prompt: "Do it.",
      },
      undefined,
      undefined,
      makeExecutionContext({
        hasUI: true,
        model,
        modelRegistry,
        onStatus: (key, text) => statuses.push({ key, text }),
      }),
    );

    expect(result.details.usage).toMatchObject({
      input: 271_801,
      cacheRead: 200,
      output: 50,
      cost: expect.closeTo(2.72046),
      costKnown: true,
      costEstimated: true,
    });
    const final = statuses.filter((status) => status.key === "pi-flow").at(-1)?.text ?? "";
    expect(final).toContain("$2.720");
    expect(final).not.toContain("$?");

    disposeSession(session);
  });

  it("marks unknown codex model cost in the status line", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-unknown-cost");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-unknown.md"), `---
description: Uses an unpriced Codex model.
backend: codex
model: custom-codex-model
---

Codex prompt.`);
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-test-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'unknown model done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const result = await tool.execute(
      "codex-unknown-cost",
      {
        description: "Unknown cost",
        subagent_type: "codex-unknown",
        prompt: "Do it.",
      },
      undefined,
      undefined,
      makeExecutionContext({
        hasUI: true,
        model,
        modelRegistry,
        onStatus: (key, text) => statuses.push({ key, text }),
      }),
    );

    expect(result.details.usage).toMatchObject({
      input: 800,
      cacheRead: 200,
      output: 50,
      cost: 0,
      costKnown: false,
    });
    const final = statuses.filter((status) => status.key === "pi-flow").at(-1)?.text ?? "";
    expect(final).toContain("pi-flow ↑800 ↓50 R200");
    expect(final).toContain("$?");

    disposeSession(session);
  });

  it("computes aggregate cache hit rate from cumulative child usage", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-aggregate-cache");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-cache.md"), `---
description: Emits deterministic cache usage.
backend: codex
model: gpt-5.4-mini
---
`);
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const cached = stdin.includes('First') ? 900 : 100;
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-cache-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'cache done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: cached, output_tokens: 10 } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onStatus: (key, text) => statuses.push({ key, text }),
    });

    await tool.execute(
      "codex-cache-first",
      { description: "First cache", subagent_type: "codex-cache", prompt: "First" },
      undefined,
      undefined,
      context,
    );
    await tool.execute(
      "codex-cache-second",
      { description: "Second cache", subagent_type: "codex-cache", prompt: "Second" },
      undefined,
      undefined,
      context,
    );

    const final = statuses.filter((status) => status.key === "pi-flow").at(-1)?.text ?? "";
    expect(final).toContain("pi-flow ↑1.0k ↓20 R1.0k CH50.0%");

    disposeSession(session);
  });
});
