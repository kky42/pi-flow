import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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
    taskNotifications,
    makeMockTheme,
    stripAnsi,
    renderToText,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
    registrations = state.registrations;
  });
  it("builds codex args and estimates costs from the Pi model catalog", () => {
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
    expect(estimateCodexCostUsd("openai/gpt-5.4-mini", usage)).toBeCloseTo(0.00084);
    expect(estimateCodexCostUsd("gpt-5.6-sol", usage)).toBeCloseTo(0.00428);
    expect(estimateCodexCostUsd("openai-codex/gpt-5.6-terra", usage)).toBeCloseTo(0.00224);
    expect(estimateCodexCostUsd("gpt-5.6-luna", usage)).toBeCloseTo(0.000224);
    // pi >= 1.2 prices gpt-5.6-sol at $4/M input, $0.4/M cache read, $20/M output,
    // with a tier above 272K input tokens ($8/$0.8/$30).
    expect(estimateCodexCostUsd("gpt-5.6-sol", {
      ...usage,
      inputTokens: 272_001,
    })).toBeCloseTo(2.176068);
    expect(estimateCodexCostUsd("unknown-model", usage)).toBeUndefined();
    expect(codexUsageToSubagentUsage("unknown-model", usage)).toMatchObject({
      input: 800,
      cacheRead: 200,
      output: 50,
      totalTokens: 1050,
      cost: { total: 0 },
    });
    expect(codexUsageToSubagentUsage("unknown-model", { ...usage, reasoningOutputTokens: 100 })).toMatchObject({
      output: 50,
      reasoning: 50,
      totalTokens: 1050,
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

  it("runs a codex-backed subagent through the run_agent tool", async () => {
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
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("run_agent", {
        label: "Codex review",
        profile: "codex-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      fauxAssistantMessage("launch observed"),
    ]);

    await session.prompt("Delegate to Codex.");
    const result = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
    const terminal = JSON.parse(result.content[0].text);

    const codexRun = JSON.parse(readFileSync(argsPath, "utf8"));
    const codexArgs = codexRun.args;
    expect(codexArgs).toContain("exec");
    expect(codexArgs).toContain("--json");
    expect(codexArgs).toContain("--model");
    expect(codexArgs).toContain("gpt-5.4-mini");
    expect(codexArgs).toContain("developer_instructions=\"Codex reviewer prompt.\"");
    expect(codexArgs).not.toContain("--ephemeral");
    expect(codexArgs.at(-1)).toBe("-");
    expect(codexRun.stdin).toBe("Review the latest diff.");
    expect(result.details).toMatchObject({
      status: "done",
      sessionKey: expect.stringMatching(/^session_/),
    });
    expect(result.usage).toMatchObject({ input: 800, cacheRead: 200, output: 50 });
    expect(terminal).toMatchObject({
      task_type: "agent",
      status: "completed",
      session_key: result.details.sessionKey,
      label: "Codex review",
      content: "codex child done",
    });
    expect(JSON.stringify(terminal)).not.toContain("session_id:");
    expect(taskNotifications(session)).toEqual([]);

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
      label: "Codex first",
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
      label: "Codex second",
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

  it("fails a persistent codex call that returns no resumable session ID", async () => {
    const binDir = join(tempDir, "bin-codex-missing-session");
    mkdirSync(binDir, { recursive: true });
    const fakeCodexPath = join(binDir, "codex");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'usable output' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
`);
    chmodSync(fakeCodexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnCodexSubagent({
      label: "Codex missing session",
      prompt: "Persist this conversation.",
      profile: {
        name: "codex-missing-session",
        description: "Codex missing session profile.",
        backend: "codex",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      persistSession: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "codex completed without a resumable session ID",
    });
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
      label: "Codex resumed usage",
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
    expect(result.usage).toMatchObject({
      input: 200,
      cacheRead: 300,
      output: 30,
      totalTokens: 530,
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
        return abortedChecks >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    const result = await spawnCodexSubagent({
      label: "Codex abort race",
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
      label: "Codex oversize",
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

  it("returns priced Codex usage above 272K from the synchronous tool", async () => {
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
    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "codex-tiered-cost",
      {
        label: "Tiered cost",
        profile: "codex-tiered",
        prompt: "Do it.",
      },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    const terminal = JSON.parse(result.content[0].text);
    expect(result.usage).toMatchObject({ input: 271801, cacheRead: 200, output: 50 });
    expect(result.usage.cost.total).toBeCloseTo(2.176, 3);
    expect(terminal).toMatchObject({ status: "completed", content: "tiered model done" });
    expect(taskNotifications(session)).toEqual([]);

    disposeSession(session);
  });

  it("marks unknown Codex model cost in the synchronous tool details", async () => {
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
    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "codex-unknown-cost",
      {
        label: "Unknown cost",
        profile: "codex-unknown",
        prompt: "Do it.",
      },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    const terminal = JSON.parse(result.content[0].text);
    expect(result.usage).toMatchObject({
      input: 800,
      cacheRead: 200,
      output: 50,
      cost: { total: 0 },
    });
    expect(result.details.telemetry).toMatchObject({ tokensKnown: true, costKnown: false });
    expect(terminal).toMatchObject({ status: "completed", content: "unknown model done" });
    expect(taskNotifications(session)).toEqual([]);

    disposeSession(session);
  });

  it("returns cache usage for consecutive synchronous child runs", async () => {
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
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });

    const first = await tool.execute(
      "codex-cache-first",
      { label: "First cache", profile: "codex-cache", prompt: "First" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(first.content[0].text).status).toBe("completed");
    expect(first.usage).toMatchObject({ input: 100, cacheRead: 900, output: 10 });
    const second = await tool.execute(
      "codex-cache-second",
      { label: "Second cache", profile: "codex-cache", prompt: "Second" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(second.content[0].text).status).toBe("completed");
    expect(second.usage).toMatchObject({ input: 900, cacheRead: 100, output: 10 });
    expect(first.usage.cacheRead + second.usage.cacheRead).toBe(1000);
    expect(first.usage.input + second.usage.input).toBe(1000);
    expect(taskNotifications(session)).toEqual([]);

    disposeSession(session);
  });
});
