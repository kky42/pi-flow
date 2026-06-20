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
  registerFauxProvider,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { getSubagentProfiles, loadBuiltinSubagentProfiles } from "../src/profiles.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeError, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";
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

    const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 0 };
    expect(estimateCodexCostUsd("openai/gpt-5.4-mini", usage)).toBeCloseTo(0.000305);
    expect(estimateCodexCostUsd("unknown-model", usage)).toBeUndefined();
    expect(codexUsageToSubagentUsage("unknown-model", usage)).toMatchObject({
      input: 800,
      cacheRead: 200,
      output: 50,
      cost: 0,
      costKnown: false,
    });
  });

  it("extracts codex final text from text, message, and structured content", () => {
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
    expect(codexArgs.at(-1)).toBe("-");
    expect(codexRun.stdin).toBe("Review the latest diff.");
    const rootMessages = JSON.stringify(rootContinuationContext?.messages);
    expect(rootMessages).toContain("codex child done");

    disposeSession(session);
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

  it("does not add unknown codex model cost to the status line", async () => {
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
    expect(final).not.toContain("$");

    disposeSession(session);
  });
});
