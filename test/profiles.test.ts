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

describe("pi-subagent profiles", () => {
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
  it("loads built-in subagent profiles from bundled markdown files", () => {
    const profiles = loadBuiltinSubagentProfiles(join(packageRoot, "src", "subagents"));

    expect(profiles.get("general-purpose")).toMatchObject({
      name: "general-purpose",
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      systemPrompt: undefined,
      tools: undefined,
    });
    expect(profiles.get("explorer")).toMatchObject({
      name: "explorer",
      description: expect.stringContaining("Fast read-only search agent"),
      tools: ["read", "grep", "find", "ls", "bash"],
    });
    expect(profiles.get("explorer")?.systemPrompt).toContain("Explorer Subagent Role");
  });

  it("loads custom subagent profiles from filename-derived names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-reviewer.md"), `---
description: Reviews code changes for correctness.
tools: read, bash
model: inherit
thinking: low
---

You are a careful code reviewer.`);
    writeFileSync(join(subagentsDir, "Bad Name.md"), `---
description: Invalid filename.
---

Ignored.`);
    writeFileSync(join(subagentsDir, "missing-description.md"), "No frontmatter.");
    writeFileSync(join(subagentsDir, "bad-thinking.md"), `---
description: Invalid thinking.
thinking: enormous
---

Ignored.`);
    writeFileSync(join(subagentsDir, "bad-model.md"), `---
description: Invalid model.
model: not-a-provider-model
---

Ignored.`);
    writeFileSync(join(subagentsDir, "unknown-tools.md"), `---
description: Keeps unknown tool names for pi to handle.
tools: read, greb
---

Unknown tools are passed through.`);
    writeFileSync(join(subagentsDir, "blank-tools.md"), `---
description: Blank tools is invalid.
tools:
---

Ignored.`);
    writeFileSync(join(subagentsDir, "null-tools.md"), `---
description: Null tools is invalid.
tools: null
---

Ignored.`);
    writeFileSync(join(subagentsDir, "empty-string-tools.md"), `---
description: Empty string tools is invalid.
tools: ""
---

Ignored.`);
    writeFileSync(join(subagentsDir, "list-tools.md"), `---
description: YAML list tools are invalid.
tools: [read, bash]
---

Ignored.`);
    writeFileSync(join(subagentsDir, "empty-list-tools.md"), `---
description: Empty list tools are invalid.
tools: []
---

Ignored.`);
    // Unparseable YAML frontmatter: parseFrontmatter throws and the profile is dropped.
    writeFileSync(join(subagentsDir, "malformed-yaml.md"), `---
description: : : oops
  bad: [unclosed
---

Ignored.`);
    // Valid frontmatter with an empty body: custom profiles may omit an extra system prompt.
    writeFileSync(join(subagentsDir, "empty-body.md"), `---
description: Valid frontmatter but empty body.
---
`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("code-reviewer")).toMatchObject({
      name: "code-reviewer",
      description: "Reviews code changes for correctness.",
      tools: ["read", "bash"],
      thinking: "low",
      systemPrompt: "You are a careful code reviewer.",
    });
    expect(profiles.get("unknown-tools")).toMatchObject({
      name: "unknown-tools",
      tools: ["read", "greb"],
      systemPrompt: "Unknown tools are passed through.",
    });
    expect(profiles.get("bad-thinking")).toMatchObject({
      name: "bad-thinking",
      thinking: "enormous",
      systemPrompt: "Ignored.",
    });
    expect(profiles.get("bad-model")).toMatchObject({
      name: "bad-model",
      model: "not-a-provider-model",
      systemPrompt: "Ignored.",
    });
    expect(profiles.get("empty-body")).toMatchObject({
      name: "empty-body",
      description: "Valid frontmatter but empty body.",
      systemPrompt: undefined,
    });
    expect(profiles.has("Bad Name")).toBe(false);
    expect(profiles.has("missing-description")).toBe(false);
    expect(profiles.has("blank-tools")).toBe(false);
    expect(profiles.has("null-tools")).toBe(false);
    expect(profiles.has("empty-string-tools")).toBe(false);
    expect(profiles.has("list-tools")).toBe(false);
    expect(profiles.has("empty-list-tools")).toBe(false);
    expect(profiles.has("malformed-yaml")).toBe(false);
    expect(profiles.has("general-purpose")).toBe(true);
    expect(profiles.has("explorer")).toBe(true);
  });

  it("loads codex-backed custom profiles with bare model names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-reviewer.md"), `---
description: Reviews through Codex CLI.
backend: codex
model: gpt-5.4-mini
thinking: low
---

Codex reviewer prompt.`);
    writeFileSync(join(subagentsDir, "bad-backend.md"), `---
description: Invalid backend.
backend: other
---

Ignored.`);
    writeFileSync(join(subagentsDir, "custom-codex-model.md"), `---
description: Arbitrary Codex model.
backend: codex
model: "gpt 5.4"
---

Arbitrary Codex model prompt.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("codex-reviewer")).toMatchObject({
      name: "codex-reviewer",
      description: "Reviews through Codex CLI.",
      backend: "codex",
      model: "gpt-5.4-mini",
      thinking: "low",
      systemPrompt: "Codex reviewer prompt.",
    });
    expect(profiles.get("custom-codex-model")).toMatchObject({
      name: "custom-codex-model",
      description: "Arbitrary Codex model.",
      backend: "codex",
      model: "gpt 5.4",
      systemPrompt: "Arbitrary Codex model prompt.",
    });
    expect(profiles.has("bad-backend")).toBe(false);
  });


  it("loads claude-backed custom profiles with bare model names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "claude-reviewer.md"), `---
description: Reviews through Claude Code.
backend: claude
model: sonnet
thinking: xhigh
---

Claude reviewer prompt.`);
    writeFileSync(join(subagentsDir, "custom-claude-model.md"), `---
description: Arbitrary Claude model.
backend: claude
model: "not a model"
thinking: max
---

Arbitrary Claude model prompt.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("claude-reviewer")).toMatchObject({
      name: "claude-reviewer",
      description: "Reviews through Claude Code.",
      backend: "claude",
      model: "sonnet",
      thinking: "xhigh",
      systemPrompt: "Claude reviewer prompt.",
    });
    expect(profiles.get("custom-claude-model")).toMatchObject({
      name: "custom-claude-model",
      description: "Arbitrary Claude model.",
      backend: "claude",
      model: "not a model",
      thinking: "max",
      systemPrompt: "Arbitrary Claude model prompt.",
    });
  });
});
