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
import { packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pi-subagent workflow integration", () => {
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
  describe("workflow tool integration", () => {
    it("runs a workflow that delegates to a real subagent and returns its text", async () => {
      const { session, registration, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;

      registration.setResponses([fauxAssistantMessage("child analysis done")]);

      const script = `export const meta = { name: 'inspect', description: 'inspect a module' };\nreturn await agent('analyze the module', { label: 'analyze' });`;
      const result = await tool.execute(
        "wf-text",
        { script },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.agentCount).toBe(1);
      expect(result.details.result).toBe("child analysis done");
      expect(registration.getPendingResponseCount()).toBe(0);

      disposeSession(session);
    });

    it("applies the configured timeout to workflow subagents", async () => {
      const { session, registration, model, modelRegistry } = await createSession({ subagentTimeoutMs: 20 });
      const tool = session.getToolDefinition("workflow") as any;

      registration.setResponses([
        async () => {
          await delay(80);
          return fauxAssistantMessage("late workflow child output");
        },
      ]);

      const script = `export const meta = { name: 'slow-flow', description: 'slow workflow child' };\nreturn await agent('wait too long', { label: 'slow' });`;
      const result = await tool.execute(
        "wf-timeout",
        { script },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.result).toBeNull();
      expect(result.details.logs.some((log: string) => log.includes("Subagent timed out after 20ms"))).toBe(true);
      expect(result.details.agents[0]?.status).toBe("error");
      expect(result.details.agents[0]?.error).toContain("Subagent timed out after 20ms");

      disposeSession(session);
    });

    it("runs a saved workflow by name", async () => {
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      writeFileSync(
        join(agentDir, "workflows", "saved-review.js"),
        `export const meta = { name: 'saved-review', description: 'Review through a saved workflow' };\nreturn await agent('saved workflow task', { label: 'saved' });`,
      );

      const { session, registration, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;

      registration.setResponses([fauxAssistantMessage("saved child done")]);

      const result = await tool.execute(
        "wf-saved",
        { name: "saved-review" },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.source).toBe("saved");
      expect(result.details.sourcePath).toContain("saved-review.js");
      expect(result.details.result).toBe("saved child done");

      disposeSession(session);
    });

    it("returns the saved workflow roster when a saved workflow name is unknown", async () => {
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      writeFileSync(
        join(agentDir, "workflows", "known.js"),
        `export const meta = { name: 'known-flow', description: 'Known flow' };\nreturn await agent('known');`,
      );

      const { session, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;

      const result = await tool.execute(
        "wf-missing",
        { name: "missing-flow" },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      expect(result.details.status).toBe("error");
      expect(result.content[0].text).toContain('Unknown saved workflow "missing-flow"');
      expect(result.content[0].text).toContain("known-flow");

      disposeSession(session);
    });

    it("rejects missing or ambiguous workflow sources", async () => {
      const { session, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;
      const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
      const script = `export const meta = { name: 'ambiguous', description: 'Ambiguous source test' };\nreturn await agent('x');`;

      const missing = await tool.execute("wf-no-source", {}, undefined, undefined, context);
      expect(missing.details.status).toBe("error");
      expect(missing.content[0].text).toContain("exactly one non-empty source");

      const multiple = await tool.execute(
        "wf-multiple-sources",
        { script, name: "ambiguous" },
        undefined,
        undefined,
        context,
      );
      expect(multiple.details.status).toBe("error");
      expect(multiple.content[0].text).toContain("exactly one non-empty source");

      disposeSession(session);
    });

    it("rejects resumeFromRunId unless scriptPath is the workflow source", async () => {
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      writeFileSync(
        join(agentDir, "workflows", "saved-review.js"),
        `export const meta = { name: 'saved-review', description: 'Review through a saved workflow' };\nreturn await agent('saved workflow task', { label: 'saved' });`,
      );

      const { session, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;
      const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
      const script = `export const meta = { name: 'resume_inline', description: 'Resume misuse test' };\nreturn await agent('x', { label: 'x' });`;

      const inline = await tool.execute(
        "wf-resume-inline",
        { script, resumeFromRunId: "wf_previous" },
        undefined,
        undefined,
        context,
      );
      expect(inline.details.status).toBe("error");
      expect(inline.details.source).toBe("inline");
      expect(inline.details.scriptPath).toBeUndefined();
      expect(inline.content[0].text).toContain("resumeFromRunId can only be used with scriptPath");

      const saved = await tool.execute(
        "wf-resume-saved",
        { name: "saved-review", resumeFromRunId: "wf_previous" },
        undefined,
        undefined,
        context,
      );
      expect(saved.details.status).toBe("error");
      expect(saved.details.source).toBe("saved");
      expect(saved.content[0].text).toContain("resumeFromRunId can only be used with scriptPath");

      disposeSession(session);
    });

    it("persists inline scripts and resumes an edited scriptPath from a previous run id", async () => {
      const { session, registration, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;

      registration.setResponses([fauxAssistantMessage("first v1"), fauxAssistantMessage("second v1")]);

      const script = `export const meta = { name: 'resume_flow', description: 'Resume test flow' };
const a = await agent('first prompt', { label: 'first' });
const b = await agent('second prompt', { label: 'second' });
return [a, b];`;
      const first = await tool.execute(
        "wf-resume-1",
        { script },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
      );

      expect(first.details.status).toBe("completed");
      expect(first.details.scriptPath).toContain("resume_flow");
      expect(first.details.runId).toMatch(/^wf_/);
      expect(first.details.result).toEqual(["first v1", "second v1"]);

      writeFileSync(
        first.details.scriptPath,
        script.replace("second prompt", "second prompt changed"),
      );
      registration.setResponses([fauxAssistantMessage("second v2")]);

      const second = await tool.execute(
        "wf-resume-2",
        { scriptPath: first.details.scriptPath, resumeFromRunId: first.details.runId },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
      );

      expect(second.details.status).toBe("completed");
      expect(second.details.source).toBe("path");
      expect(second.details.cachedAgentCount).toBe(1);
      expect(second.details.result).toEqual(["first v1", "second v2"]);
      expect(registration.getPendingResponseCount()).toBe(0);

      disposeSession(session);
    });

    it("captures schema-validated structured output from a workflow subagent", async () => {
      const { session, registration, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;

      // Child: end on a structured_output tool call, then stop on the next turn.
      registration.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("structured_output", { answer: "42", confidence: 0.9 })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);

      const script = `export const meta = { name: 'solve', description: 'solve a task' };
return await agent('compute the answer', {
  label: 'solver',
  schema: { type: 'object', properties: { answer: { type: 'string' }, confidence: { type: 'number' } }, required: ['answer'] },
});`;
      const result = await tool.execute(
        "wf-struct",
        { script },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.result).toEqual({ answer: "42", confidence: 0.9 });

      disposeSession(session);
    });

    it("captures schema-validated structured output from a claude workflow subagent", async () => {
      const subagentsDir = join(agentDir, "subagents");
      const binDir = join(tempDir, "bin-claude-workflow-struct");
      const argsPath = join(tempDir, "claude-workflow-args.json");
      mkdirSync(subagentsDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(subagentsDir, "claude-struct.md"), `---
description: Returns structured output through Claude Code.
backend: claude
model: sonnet
---

Claude structured prompt.`);
      const fakeClaudePath = join(binDir, "claude");
      writeFileSync(fakeClaudePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-struct-session' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { answer: '42', confidence: 0.9 }, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } }));
`);
      chmodSync(fakeClaudePath, 0o755);
      process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

      const { session, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;
      const script = `export const meta = { name: 'claude_struct', description: 'structured claude task' };
return await agent('compute the answer', {
  label: 'solver',
  subagent_type: 'claude-struct',
  schema: { type: 'object', properties: { answer: { type: 'string' }, confidence: { type: 'number' } }, required: ['answer'] },
});`;
      const result = await tool.execute(
        "wf-claude-struct",
        { script },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.agents[0]?.backend).toBe("claude");
      expect(result.details.result).toEqual({ answer: "42", confidence: 0.9 });
      const claudeRun = JSON.parse(readFileSync(argsPath, "utf8"));
      expect(claudeRun.args).toContain("--json-schema");
      expect(claudeRun.stdin).toContain("Structured output contract");

      disposeSession(session);
    });

    it("does not expose Agent or workflow to a workflow's subagents", async () => {
      const { session, registration, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;
      let childContext: Context | undefined;

      registration.setResponses([
        (context) => {
          childContext = context;
          return fauxAssistantMessage("inspected tools");
        },
      ]);

      const script = `export const meta = { name: 'nest', description: 'nesting check' };\nreturn await agent('report available tools', { label: 'probe' });`;
      await tool.execute(
        "wf-nest",
        { script },
        undefined,
        undefined,
        makeExecutionContext({ hasUI: false, model, modelRegistry }),
      );

      const childToolNames = getToolNames(childContext);
      expect(childToolNames).not.toContain("Agent");
      expect(childToolNames).not.toContain("workflow");

      disposeSession(session);
    });

    it("streams live progress snapshots as phases and agents advance", async () => {
      const { session, registration, model, modelRegistry } = await createSession();
      const tool = session.getToolDefinition("workflow") as any;
      const updates: any[] = [];

      registration.setResponses([
        fauxAssistantMessage("first done"),
        fauxAssistantMessage("second done"),
      ]);

      const script = `export const meta = { name: 'two', description: 'two-phase flow' };
phase('scan');
const a = await agent('first', { label: 'one' });
phase('report');
const b = await agent('second', { label: 'two' });
return [a, b];`;
      const result = await tool.execute(
        "wf-progress",
        { script },
        undefined,
        (update: any) => updates.push(update),
        makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }),
      );

      expect(result.details.status).toBe("completed");
      expect(result.details.phases).toEqual(["scan", "report"]);
      expect(result.details.agents.map((agent: any) => agent.status)).toEqual(["done", "done"]);
      expect(result.details.agents.map((agent: any) => agent.backend)).toEqual(["pi", "pi"]);
      expect(result.details.result).toEqual(["first done", "second done"]);

      // Progress was streamed incrementally, not just at the end.
      expect(updates.length).toBeGreaterThan(0);
      expect(
        updates.some((update) => update.details.agents.some((agent: any) => agent.status === "running")),
      ).toBe(true);
      expect(updates.some((update) => update.details.phases.includes("report"))).toBe(true);

      disposeSession(session);
    });
  });
});
