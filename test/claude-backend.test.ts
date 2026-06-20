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

describe("pi-subagent claude backend", () => {
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
  it("builds claude args and maps reported usage/cost", () => {
    const schema = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
    const args = buildClaudeArgs({
      thinkingLevel: "minimal",
      profile: {
        name: "claude-reviewer",
        description: "Claude reviewer",
        backend: "claude",
        model: "sonnet",
        systemPrompt: "You are a Claude reviewer.",
      },
      outputSchema: schema,
    });

    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--append-system-prompt",
      "You are a Claude reviewer.",
      "--model",
      "sonnet",
      "--effort",
      "minimal",
      "--json-schema",
      JSON.stringify(schema),
    ]);

    expect(claudeUsageToSubagentUsage({
      inputTokens: 100,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 300,
      outputTokens: 50,
    }, 0.123)).toMatchObject({
      input: 100,
      cacheRead: 200,
      cacheWrite: 300,
      output: 50,
      cost: 0.123,
      costKnown: true,
      costEstimated: false,
    });
    expect(claudeUsageToSubagentUsage({
      inputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 50,
    }, undefined)).toMatchObject({ cost: 0, costKnown: false });
    const resultEvent = {
      type: "result",
      total_cost_usd: 0.3,
      usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 },
      modelUsage: {
        sonnet: { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40, costUSD: 0.1 },
        haiku: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4, costUSD: 0.2 },
      },
    };
    expect(extractClaudeUsage(resultEvent)).toEqual({
      inputTokens: 11,
      cacheCreationInputTokens: 22,
      cacheReadInputTokens: 33,
      outputTokens: 44,
    });
    expect(extractClaudeCostUsd(resultEvent)).toBe(0.3);
    expect(extractClaudeCostUsd({ type: "result", modelUsage: resultEvent.modelUsage })).toBeCloseTo(0.3);
  });

  it("extracts claude final text from result, structured output, and assistant text", () => {
    expect(extractClaudeError({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    })).toBe("Claude failed: Failed to authenticate. API Error: 401 Invalid bearer token");
    expect(extractClaudeFinalText({
      type: "result",
      subtype: "success",
      result: "plain result",
    })).toBe("plain result");
    expect(extractClaudeFinalText({
      type: "result",
      subtype: "success",
      result: "",
      structured_output: { answer: "42" },
    })).toBe(JSON.stringify({ answer: "42" }));
    expect(extractClaudeFinalText({
      type: "assistant",
      message: { content: [{ type: "text", text: "assistant text" }] },
    })).toBe("assistant text");
  });

  it("runs a claude-backed subagent through the Agent tool", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-claude");
    const argsPath = join(tempDir, "claude-args.json");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "claude-reviewer.md"), `---
description: Reviews through Claude Code.
backend: claude
model: sonnet
thinking: xhigh
---

Claude reviewer prompt.`);
    const fakeClaudePath = join(binDir, "claude");
    writeFileSync(fakeClaudePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-test-session' }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git diff --stat' } }], usage: { input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 200, output_tokens: 10 } } }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude child done' }], usage: { input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 200, output_tokens: 10 } } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude child done', total_cost_usd: 0.0123, usage: { input_tokens: 150, cache_creation_input_tokens: 350, cache_read_input_tokens: 250, output_tokens: 25 } }));
`);
    chmodSync(fakeClaudePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Claude review",
        subagent_type: "claude-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to Claude.");

    const claudeRun = JSON.parse(readFileSync(argsPath, "utf8"));
    const claudeArgs = claudeRun.args;
    expect(claudeArgs).toContain("-p");
    expect(claudeArgs).toContain("--output-format");
    expect(claudeArgs).toContain("stream-json");
    expect(claudeArgs).toContain("--no-session-persistence");
    expect(claudeArgs).toContain("--dangerously-skip-permissions");
    expect(claudeArgs).not.toContain("--permission-mode");
    expect(claudeArgs).toContain("--model");
    expect(claudeArgs).toContain("sonnet");
    expect(claudeArgs).toContain("--effort");
    expect(claudeArgs).toContain("xhigh");
    expect(claudeArgs).toContain("--append-system-prompt");
    expect(claudeArgs).toContain("Claude reviewer prompt.");
    expect(claudeRun.stdin).toBe("Review the latest diff.");
    const rootMessages = JSON.stringify(rootContinuationContext?.messages);
    expect(rootMessages).toContain("claude child done");

    disposeSession(session);
  });

  it("kills a claude child if abort lands after process spawn", async () => {
    const binDir = join(tempDir, "bin-claude-abort-race");
    const markerPath = join(tempDir, "claude-child-completed");
    mkdirSync(binDir, { recursive: true });
    const fakeClaudePath = join(binDir, "claude");
    writeFileSync(fakeClaudePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.stdin.resume();
setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'completed');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-abort-race' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'should not complete', usage: { input_tokens: 10, output_tokens: 2 } }));
}, 700);
`);
    chmodSync(fakeClaudePath, 0o755);
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

    const result = await spawnClaudeSubagent({
      toolCallId: "claude-abort-race",
      description: "Claude abort race",
      prompt: "This should be aborted before stdin is sent.",
      profile: {
        name: "claude-race",
        description: "Claude abort race profile.",
        backend: "claude",
        model: "sonnet",
        systemPrompt: "Claude race prompt.",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("aborted");
    expect(result.details.backend).toBe("claude");
    expect(result.details.error).toContain("aborted before prompt start");
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(markerPath)).toBe(false);
  });

  it("fails clearly when claude emits an oversized stdout line", async () => {
    const binDir = join(tempDir, "bin-claude-oversize");
    mkdirSync(binDir, { recursive: true });
    const fakeClaudePath = join(binDir, "claude");
    writeFileSync(fakeClaudePath, `#!/usr/bin/env node
process.stdin.resume();
process.stdout.write('x'.repeat(${MAX_STDOUT_LINE_CHARS + 1024}), () => {
  setTimeout(() => process.exit(0), 50);
});
`);
    chmodSync(fakeClaudePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnClaudeSubagent({
      toolCallId: "claude-oversize",
      description: "Claude oversize",
      prompt: "Trigger oversize stdout.",
      profile: {
        name: "claude-oversize",
        description: "Claude oversize profile.",
        backend: "claude",
        model: "sonnet",
        systemPrompt: "Claude oversize prompt.",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("claude emitted a stdout line over");
    expect(result.details.error).toContain("without a newline");
  });
});
