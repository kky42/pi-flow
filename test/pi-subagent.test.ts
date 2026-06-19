import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  Theme,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { getSubagentProfiles, loadBuiltinSubagentProfiles } from "../src/profiles.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// pi-coding-agent 0.77.0 carries its own pi-ai instance; faux providers must register there.

type FauxModelDef = { id: string; name: string; reasoning: boolean };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type CreateSessionOptions = {
  maxConcurrency?: number;
  models?: FauxModelDef[];
  defaultModelId?: string;
  thinkingLevel?: ThinkingLevel;
};

describe("pi-subagent", () => {
  let tempDir: string;
  let cwd: string;
  let agentDir: string;
  let registrations: Array<{ unregister: () => void }>;
  let sessions: Array<{ dispose: () => void }>;
  let originalAgentDirEnv: string | undefined;
  let originalPathEnv: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tempDir, "project");
    agentDir = join(tempDir, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    originalPathEnv = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    registrations = [];
    sessions = [];
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    for (const registration of registrations.splice(0)) {
      registration.unregister();
    }
    if (originalAgentDirEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    }
    if (originalPathEnv === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPathEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function trackSession<T extends { dispose: () => void }>(session: T): T {
    sessions.push(session);
    return session;
  }

  function disposeSession(session: { dispose: () => void }): void {
    const index = sessions.indexOf(session);
    if (index !== -1) {
      sessions.splice(index, 1);
    }
    session.dispose();
  }

  const DEFAULT_MODEL_DEFS: FauxModelDef[] = [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }];

  // Mirror the registered faux models into models.json so that subagent profile
  // `model:` overrides resolve through ModelRegistry.find(provider, id) exactly
  // like real custom models. Without this, find() only knows the built-in
  // catalog and any profile model override would be filtered out as unavailable.
  function writeModelsJson(models: Array<Model<string>>) {
    if (models.length === 0) {
      return;
    }
    const toModelDef = (m: Model<string>) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      baseUrl: m.baseUrl,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    });
    const provider = models[0].provider;
    const config = {
      providers: {
        [provider]: {
          apiKey: "test-api-key",
          api: models[0].api,
          baseUrl: models[0].baseUrl,
          models: models.map(toModelDef),
        },
      },
    };
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
  }

  async function createSession(options: CreateSessionOptions = {}) {
    const { maxConcurrency, models: modelDefs = DEFAULT_MODEL_DEFS, defaultModelId, thinkingLevel = "high" } = options;
    const registration = registerFauxProvider({ models: modelDefs });
    registrations.push(registration);

    const models = modelDefs.map((def) => registration.getModel(def.id) as Model<string>);
    const model = defaultModelId ? (registration.getModel(defaultModelId) as Model<string>) : models[0];

    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    authStorage.setRuntimeApiKey(model.provider, "test-api-key");
    writeModelsJson(models);
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const settingsManager = SettingsManager.inMemory({});
    const sessionManager = SessionManager.inMemory(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [createSubagentExtension(maxConcurrency === undefined ? {} : { maxConcurrency })],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel,
      settingsManager,
      sessionManager,
      resourceLoader,
    });
    trackSession(session);
    await session.bindExtensions({});

    return { session, registration, model, models, modelRegistry };
  }

  // Drive a single root delegation and capture the child session's context,
  // stream options, model, and the root's post-delegation continuation context.
  async function delegateOnce(
    session: { prompt: (input: string) => Promise<unknown> },
    registration: ReturnType<typeof registerFauxProvider>,
    toolArgs: Record<string, unknown>,
    opts: { childReply?: string; rootReply?: string; userPrompt?: string } = {},
  ) {
    const { childReply = "child done", rootReply = "reported", userPrompt = "Please delegate." } = opts;
    const captured: {
      childContext?: Context;
      childOptions?: SimpleStreamOptions;
      childModel?: Model<string>;
      rootContinuationContext?: Context;
    } = {};
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", toolArgs)], { stopReason: "toolUse" }),
      (context, options, _state, model) => {
        captured.childContext = context;
        captured.childOptions = options as SimpleStreamOptions;
        captured.childModel = model;
        return fauxAssistantMessage(childReply);
      },
      (context) => {
        captured.rootContinuationContext = context;
        return fauxAssistantMessage(rootReply);
      },
    ]);
    await session.prompt(userPrompt);
    return captured;
  }

  function makeMockTheme() {
    const theme = new Theme({} as never, {} as never, "truecolor");
    (theme as unknown as { fg: (color: string, text: string) => string }).fg = (_color, text) => text;
    (theme as unknown as { bold: (text: string) => string }).bold = (text) => text;
    return theme;
  }

  function stripAnsi(s: string) {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
  }

  function renderToText(component: { render: (width: number) => string[] }) {
    return stripAnsi(component.render(200).join("\n"));
  }

  function formatTestTokens(count: number) {
    if (count < 1000) {
      return count.toString();
    }
    if (count < 10000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    if (count < 1000000) {
      return `${Math.round(count / 1000)}k`;
    }
    if (count < 10000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    return `${Math.round(count / 1000000)}M`;
  }

  function makeExecutionContext({
    hasUI,
    model,
    modelRegistry,
    tui = false,
    onStatus,
    projectTrusted = false,
    persistedSession = false,
  }: {
    hasUI: boolean;
    model: Model<string>;
    modelRegistry: ModelRegistry;
    tui?: boolean;
    onStatus?: (key: string, text: string | undefined) => void;
    projectTrusted?: boolean;
    persistedSession?: boolean;
  }) {
    const theme = makeMockTheme();
    const sessionDir = join(tempDir, "sessions");
    return {
      hasUI,
      cwd,
      model,
      modelRegistry,
      sessionManager: persistedSession
        ? {
            isPersisted: () => true,
            getSessionFile: () => join(sessionDir, "session.jsonl"),
            getSessionDir: () => sessionDir,
            getSessionId: () => "test-session",
          }
        : undefined,
      isProjectTrusted: () => projectTrusted,
      ui: {
        getAllThemes: () => (tui ? [{ name: "test", path: "test-theme.json" }] : []),
        setStatus: (key: string, text: string | undefined) => onStatus?.(key, text),
        theme,
      },
    };
  }

  function getToolNames(context: Context | undefined): string[] {
    return [...new Set((context?.tools ?? [])
      .map((tool: { name?: string } | undefined) => tool?.name)
      .filter((name): name is string => typeof name === "string"))].sort();
  }

  it("registers the Claude-style Agent tool contract", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    expect(tool).toBeDefined();
    const properties = (tool?.parameters as { properties: Record<string, unknown> } | undefined)?.properties;
    expect(properties).toHaveProperty("description");
    expect(properties).toHaveProperty("prompt");
    expect(properties).toHaveProperty("subagent_type");
    expect(properties).not.toHaveProperty("run_in_background");
    expect(properties).not.toHaveProperty("resume");
    expect(properties).not.toHaveProperty("model");
    expect(properties).not.toHaveProperty("thinking");
    expect(tool?.description).toContain("Available agents");
    expect(tool?.promptGuidelines).toContain(
      "Reach for Agent when the task matches an available agent, when you have independent work to run in parallel, or when answering would mean reading across several files.",
    );

    disposeSession(session);
  });

  it("marks description and prompt required, subagent_type optional, and adds no tag/label fields", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    const schema = tool?.parameters as { required?: string[]; properties: Record<string, unknown> } | undefined;
    expect(schema?.required).toContain("description");
    expect(schema?.required).toContain("prompt");
    expect(schema?.required ?? []).not.toContain("subagent_type");
    expect(schema?.properties).not.toHaveProperty("tag");
    expect(schema?.properties).not.toHaveProperty("label");

    disposeSession(session);
  });

  it("loads as a pi package extension from package metadata", async () => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await resourceLoader.reload();

    const extensions = resourceLoader.getExtensions();
    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions).toHaveLength(1);
  });

  it("runs an explorer subagent with fresh context and appended explorer prompt", async () => {
    const { session, registration } = await createSession();
    let childContext: Context | undefined;
    let childOptions: SimpleStreamOptions | undefined;
    let childModel: Model<string> | undefined;
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Find auth files",
        subagent_type: "explorer",
        prompt: "Search for the auth flow and report key files.",
      })], { stopReason: "toolUse" }),
      (context, options, _state, model) => {
        childContext = context;
        childOptions = options;
        childModel = model;
        return fauxAssistantMessage("found auth.ts");
      },
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported to user");
      },
    ]);

    await session.prompt("Please delegate the auth search.");

    expect(childModel?.id).toBe("faux-thinker");
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBe("high");
    expect(childContext?.systemPrompt).toContain("Explorer Subagent Role");
    expect(childContext?.systemPrompt).not.toContain("Subagent Delegation");
    expect(getToolNames(childContext)).toEqual(["bash", "find", "grep", "ls", "read"]);
    expect(JSON.stringify(childContext?.messages)).toContain("Search for the auth flow");
    expect(JSON.stringify(childContext?.messages)).not.toContain("Please delegate the auth search");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("found auth.ts");

    disposeSession(session);
  });

  it("preserves discovered append system prompts in child sessions", async () => {
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Project append marker must survive into subagents.");

    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Find auth files",
        subagent_type: "explorer",
        prompt: "Search for the auth flow and report key files.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        return fauxAssistantMessage("found auth.ts");
      },
      fauxAssistantMessage("reported to user"),
    ]);

    await session.prompt("Please delegate the auth search.");

    expect(childContext?.systemPrompt).toContain("Project append marker must survive into subagents.");
    expect(childContext?.systemPrompt).toContain("Explorer Subagent Role");
    expect(childContext?.systemPrompt).not.toContain("Subagent Delegation");

    disposeSession(session);
  });

  it("does not append an extra role prompt for general-purpose subagents", async () => {
    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Research config",
        prompt: "Inspect config loading.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        return fauxAssistantMessage("config found");
      },
      fauxAssistantMessage("done"),
    ]);

    await session.prompt("Delegate config research.");

    expect(childContext?.systemPrompt).not.toContain("Explorer Subagent Role");
    expect(childContext?.systemPrompt).not.toContain("Subagent Delegation");
    expect(JSON.stringify(childContext?.messages)).toContain("Inspect config loading.");

    disposeSession(session);
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
    // Valid frontmatter but an empty body: custom profiles require a non-empty body.
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
    expect(profiles.has("Bad Name")).toBe(false);
    expect(profiles.has("missing-description")).toBe(false);
    expect(profiles.has("bad-thinking")).toBe(false);
    expect(profiles.has("bad-model")).toBe(false);
    expect(profiles.has("blank-tools")).toBe(false);
    expect(profiles.has("null-tools")).toBe(false);
    expect(profiles.has("empty-string-tools")).toBe(false);
    expect(profiles.has("list-tools")).toBe(false);
    expect(profiles.has("empty-list-tools")).toBe(false);
    expect(profiles.has("malformed-yaml")).toBe(false);
    expect(profiles.has("empty-body")).toBe(false);
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
    writeFileSync(join(subagentsDir, "bad-codex-model.md"), `---
description: Invalid Codex model.
backend: codex
model: "gpt 5.4"
---

Ignored.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("codex-reviewer")).toMatchObject({
      name: "codex-reviewer",
      description: "Reviews through Codex CLI.",
      backend: "codex",
      model: "gpt-5.4-mini",
      thinking: "low",
      systemPrompt: "Codex reviewer prompt.",
    });
    expect(profiles.has("bad-backend")).toBe(false);
    expect(profiles.has("bad-codex-model")).toBe(false);
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
      "--sandbox",
      "workspace-write",
      "-c",
      "developer_instructions=\"You are a Codex reviewer.\"",
      "--model",
      "gpt-5.4-mini",
      "-c",
      "model_reasoning_effort=\"high\"",
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

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("aborted before prompt start");
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(markerPath)).toBe(false);
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
    writeFileSync(join(subagentsDir, "bad-claude-model.md"), `---
description: Invalid Claude model.
backend: claude
model: "not a model"
---

Ignored.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("claude-reviewer")).toMatchObject({
      name: "claude-reviewer",
      description: "Reviews through Claude Code.",
      backend: "claude",
      model: "sonnet",
      thinking: "xhigh",
      systemPrompt: "Claude reviewer prompt.",
    });
    expect(profiles.has("bad-claude-model")).toBe(false);
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
      "--permission-mode",
      "acceptEdits",
      "--append-system-prompt",
      "You are a Claude reviewer.",
      "--model",
      "sonnet",
      "--effort",
      "low",
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
    expect(claudeArgs).toContain("--permission-mode");
    expect(claudeArgs).toContain("acceptEdits");
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

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("aborted before prompt start");
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(markerPath)).toBe(false);
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
    const final = statuses.filter((status) => status.key === "pi-subagents").at(-1)?.text ?? "";
    expect(final).toContain("pi-subagents ↑800 ↓50 R200");
    expect(final).not.toContain("$");

    disposeSession(session);
  });

  it("runs a custom subagent with appended body prompt and thinking override", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-reviewer.md"), `---
description: Reviews code changes for correctness.
tools: read, bash
thinking: low
---

Custom reviewer prompt marker.`);

    const { session, registration } = await createSession();
    let childContext: Context | undefined;
    let childOptions: SimpleStreamOptions | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Review changes",
        subagent_type: "code-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      (context, options) => {
        childContext = context;
        childOptions = options;
        return fauxAssistantMessage("review complete");
      },
      fauxAssistantMessage("reported"),
    ]);

    await session.prompt("Delegate code review.");

    expect(childContext?.systemPrompt).toContain("Custom reviewer prompt marker.");
    expect(childContext?.systemPrompt).not.toContain("Explorer Subagent Role");
    expect(getToolNames(childContext)).toEqual(["bash", "read"]);
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBe("low");
    expect(JSON.stringify(childContext?.messages)).toContain("Review the latest diff.");

    disposeSession(session);
  });

  it("runs a custom subagent on the valid model named in its profile, not the caller's model", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "fast-agent.md"), `---
description: Runs on the fast model.
model: faux/faux-fast
---

Fast agent prompt marker.`);

    const { session, registration, model: callerModel } = await createSession({
      models: [
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        { id: "faux-fast", name: "Faux Fast", reasoning: false },
      ],
      defaultModelId: "faux-thinker",
    });
    expect(callerModel.id).toBe("faux-thinker");

    const captured = await delegateOnce(session, registration, {
      description: "Fast task",
      subagent_type: "fast-agent",
      prompt: "Do the fast thing.",
    });

    // The child must actually stream on the profile's model (the 4th faux
    // callback arg is the model the session ran with), not the caller's model.
    expect(captured.childModel?.id).toBe("faux-fast");
    expect(captured.childModel?.id).not.toBe(callerModel.id);
    expect(captured.childContext?.systemPrompt).toContain("Fast agent prompt marker.");

    disposeSession(session);
  });

  it("uses the default child-session tools when a subagent profile omits tools", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "default-tools.md"), `---
description: Uses the default tool set.
---

Default tools prompt marker.`);

    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Default tools",
        subagent_type: "default-tools",
        prompt: "Inspect the available child-session tools.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        return fauxAssistantMessage("default tools inspected");
      },
      fauxAssistantMessage("reported"),
    ]);

    await session.prompt("Delegate a default-tools subagent.");

    expect(childContext?.systemPrompt).toContain("Default tools prompt marker.");
    expect(getToolNames(childContext)).toEqual(["bash", "edit", "read", "write"]);

    disposeSession(session);
  });

  it("does not count an unavailable-profile-model rejection toward maxConcurrency", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "bad-model-agent.md"), `---
description: Uses an unavailable registered model.
model: ghost/nope
---

This should not be advertised or launched.`);

    const { session, registration } = await createSession({ maxConcurrency: 1 });
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "Bad model first",
          subagent_type: "bad-model-agent",
          prompt: "This should be rejected before launch.",
        }),
        fauxToolCall("Agent", {
          description: "Valid second",
          prompt: "This valid child should still run.",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("valid child ran"),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    await session.prompt("Run one bad and one good subagent.");

    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("Unknown subagent_type");
    expect(serialized).toContain("valid child ran");
    expect(serialized).not.toContain("Maximum subagent concurrency reached");

    disposeSession(session);
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

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("aborted before prompt start");
    expect(childContext).toBeUndefined();
    expect(registration.getPendingResponseCount()).toBe(1);

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

    expect(result.details.progress?.id).toBe("root-progress-a");
    expect(result.details.progress?.description).toBe("Same audit");
    expect(result.details.usage?.input).toBeGreaterThan(0);
    expect(result.details.usage?.output).toBeGreaterThan(0);
    expect(result.details.progress?.usage).toEqual(result.details.usage);

    disposeSession(session);
  });

  it("updates a cumulative pi-subagents status line from child usage", async () => {
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

    const final = statuses.filter((status) => status.key === "pi-subagents").at(-1)?.text ?? "";
    const usage = {
      input: first.details.usage.input + second.details.usage.input,
      output: first.details.usage.output + second.details.usage.output,
      cacheRead: first.details.usage.cacheRead + second.details.usage.cacheRead,
      cacheWrite: first.details.usage.cacheWrite + second.details.usage.cacheWrite,
      cost: first.details.usage.cost + second.details.usage.cost,
      latestCacheHitRate: second.details.usage.latestCacheHitRate,
    };
    const expected = `pi-subagents ↑${formatTestTokens(usage.input)} ↓${formatTestTokens(usage.output)}`;

    expect(statuses.some((status) => status.key === "pi-subagents" && status.text)).toBe(true);
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

  it("rejects unknown subagent names without aliases", async () => {
    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Find auth files",
        subagent_type: "explore",
        prompt: "Search for auth.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("saw rejection");
      },
    ]);

    await session.prompt("Delegate with old name.");

    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("Unknown subagent_type");
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("enforces maxConcurrency for foreground parallel Agent calls", async () => {
    const { session, registration } = await createSession({ maxConcurrency: 1 });
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "First search",
          prompt: "First search task.",
        }),
        fauxToolCall("Agent", {
          description: "Second search",
          prompt: "Second search task.",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("first result"),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    await session.prompt("Run two searches.");

    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("first result");
    expect(serialized).toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });

  it("does not expose Agent to subagent sessions", async () => {
    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Search",
        prompt: "Report whether the Agent tool is available.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        const hasAgent = context.tools?.some((tool: { name?: string }) => tool.name === "Agent") ?? false;
        return fauxAssistantMessage(hasAgent ? "Agent visible" : "Agent hidden");
      },
      fauxAssistantMessage("done"),
    ]);

    await session.prompt("Delegate once.");

    expect(childContext?.tools?.some((tool: { name?: string }) => tool.name === "Agent")).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("Agent hidden");
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("does not leak a prior parent tool result into a later child session", async () => {
    const { session, registration } = await createSession();
    let secondChildContext: Context | undefined;

    registration.setResponses([
      // Round 1: the parent delegates, producing an Agent tool result that is
      // appended to the parent conversation.
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "First search", prompt: "First task." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("FIRST_CHILD_SECRET_RESULT"),
      // Parent continuation: delegate again now that the first tool result is in
      // the parent history.
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Second search", prompt: "Second task." })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        secondChildContext = context;
        return fauxAssistantMessage("second child done");
      },
      fauxAssistantMessage("reported"),
    ]);

    await session.prompt("Delegate twice in sequence.");

    const serialized = JSON.stringify(secondChildContext?.messages);
    expect(serialized).toContain("Second task.");
    // The second child gets a fresh context: no parent user prompt, no earlier
    // delegated prompt, and crucially no earlier child's tool result.
    expect(serialized).not.toContain("FIRST_CHILD_SECRET_RESULT");
    expect(serialized).not.toContain("First task.");
    expect(serialized).not.toContain("Delegate twice in sequence.");

    disposeSession(session);
  });

  it("injects the coordinator prompt into the root agent's system prompt", async () => {
    const { session, registration } = await createSession();
    let rootContext: Context | undefined;

    registration.setResponses([
      (context) => {
        rootContext = context;
        return fauxAssistantMessage("noted");
      },
    ]);

    await session.prompt("Just say noted.");

    expect(rootContext?.systemPrompt).toContain("Subagent Delegation");
    expect(rootContext?.systemPrompt).toContain("Pi-backed subagents do not receive Agent");
    expect(rootContext?.systemPrompt).toContain("Root-level parallel delegation is bounded");
    expect(rootContext?.systemPrompt).not.toContain("max concurrency 4");
    expect(rootContext?.systemPrompt).toContain("Available agents");
    expect(rootContext?.systemPrompt).toContain("general-purpose: General-purpose agent for researching complex questions");
    expect(rootContext?.systemPrompt).toContain("explorer: Fast read-only search agent");
    expect(rootContext?.systemPrompt).toContain("Reach for Agent when the task matches an available agent");
    expect(rootContext?.systemPrompt).toContain('User asks "explore this repo"');
    expect(rootContext?.systemPrompt).toContain("single-fact lookup");
    expect(rootContext?.systemPrompt).toContain("Once you delegate a search");

    disposeSession(session);
  });

  it("advertises saved workflows in the root system prompt", async () => {
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "audit.js"),
      `export const meta = { name: 'audit-todos', description: 'Find TODOs and summarize debt. Use before cleanup planning.' };\nreturn await agent('audit');`,
    );

    const { session, registration } = await createSession();
    let rootContext: Context | undefined;

    registration.setResponses([
      (context) => {
        rootContext = context;
        return fauxAssistantMessage("noted");
      },
    ]);

    await session.prompt("Can you clean up technical debt?");

    expect(rootContext?.systemPrompt).toContain("Saved workflows");
    expect(rootContext?.systemPrompt).toContain("audit-todos: Find TODOs and summarize debt. Use before cleanup planning.");
    expect(rootContext?.systemPrompt).toContain("Use `{ name: 'saved-workflow-name', args }`");

    disposeSession(session);
  });

  it("frees slots across user turns so a later turn can still delegate under the cap", async () => {
    // With a live in-flight gauge (and no per-turn reset), each turn's child
    // releases its slot on completion, so the next turn delegates under the cap.
    const { session, registration } = await createSession({ maxConcurrency: 1 });

    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Turn 1 search", prompt: "First task." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("turn 1 child done"),
      fauxAssistantMessage("turn 1 reply"),
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Turn 2 search", prompt: "Second task." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("turn 2 child done"),
      fauxAssistantMessage("turn 2 reply"),
    ]);

    await session.prompt("Turn 1 — please delegate.");
    await session.prompt("Turn 2 — please delegate again.");

    const serialized = JSON.stringify(session.messages);
    expect(serialized).toContain("turn 1 child done");
    expect(serialized).toContain("turn 2 child done");
    expect(serialized).not.toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });

  it("counts live in-flight children, not a per-turn quota", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrency: 2 });
    const tool = session.getToolDefinition("Agent") as any;
    const ctx = makeExecutionContext({ hasUI: false, model, modelRegistry });

    // Two children that stay in-flight until released, plus a recovery response.
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    registration.setResponses([
      async () => {
        await gate1;
        return fauxAssistantMessage("child 1 done");
      },
      async () => {
        await gate2;
        return fauxAssistantMessage("child 2 done");
      },
      fauxAssistantMessage("recovery child done"),
    ]);

    // The slot is taken synchronously before runSubagent's first await, so two
    // un-awaited launches saturate the cap of 2 with both children still running.
    const inFlight1 = tool.execute("c1", { description: "A", prompt: "Task A." }, undefined, undefined, ctx);
    const inFlight2 = tool.execute("c2", { description: "B", prompt: "Task B." }, undefined, undefined, ctx);

    // A third launch while two are genuinely in-flight must be rejected by the
    // live cap — a per-turn quota that reset or only counted completed children
    // would let this through.
    const rejected = await tool.execute("c3", { description: "C", prompt: "Task C." }, undefined, undefined, ctx);
    expect(rejected.details.status).toBe("rejected");
    expect(rejected.details.error).toBe("Maximum subagent concurrency reached");

    // Release one child: its slot frees, so a new launch now succeeds.
    release1();
    expect((await inFlight1).details.status).toBe("completed");
    const recovered = await tool.execute("c4", { description: "D", prompt: "Task D." }, undefined, undefined, ctx);
    expect(recovered.details.status).toBe("completed");
    expect(recovered.details.result).toContain("recovery child done");

    release2();
    expect((await inFlight2).details.status).toBe("completed");

    disposeSession(session);
  });

  it("releases completed subagents before later tool rounds in the same user prompt", async () => {
    const { session, registration } = await createSession({ maxConcurrency: 4 });

    registration.setResponses([
      fauxAssistantMessage(
        [1, 2, 3, 4].map((index) =>
          fauxToolCall("Agent", { description: `Round 1 search ${index}`, prompt: `First round task ${index}.` }),
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("round 1 child 1 done"),
      fauxAssistantMessage("round 1 child 2 done"),
      fauxAssistantMessage("round 1 child 3 done"),
      fauxAssistantMessage("round 1 child 4 done"),
      fauxAssistantMessage(
        [1, 2, 3, 4].map((index) =>
          fauxToolCall("Agent", { description: `Round 2 search ${index}`, prompt: `Second round task ${index}.` }),
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("round 2 child 1 done"),
      fauxAssistantMessage("round 2 child 2 done"),
      fauxAssistantMessage("round 2 child 3 done"),
      fauxAssistantMessage("round 2 child 4 done"),
      fauxAssistantMessage("root done"),
    ]);

    await session.prompt("Run four searches, then after they finish run four more.");

    const serialized = JSON.stringify(session.messages);
    expect(serialized).toContain("round 1 child 4 done");
    expect(serialized).toContain("round 2 child 4 done");
    expect(serialized).not.toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });

  it("releases the slot when a child fails so a later delegation still launches", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrency: 1 });
    const tool = session.getToolDefinition("Agent") as any;
    const ctx = makeExecutionContext({ hasUI: false, model, modelRegistry });

    // Drive execute() directly so the failure path is deterministic and the
    // per-turn reset does not mask whether the finally released the slot.
    registration.setResponses([fauxAssistantMessage("recovery child done")]);

    const aborted = new AbortController();
    aborted.abort();
    const failed = await tool.execute(
      "failed-agent-call",
      { description: "Doomed search", prompt: "First task that fails." },
      aborted.signal,
      undefined,
      ctx,
    );
    expect(failed.details.status).toBe("error");
    expect(failed.details.error).toContain("aborted before prompt start");

    // With maxConcurrency 1, the second launch is only possible if the failed
    // child released its slot via the same finally that releases completed ones.
    const recovered = await tool.execute(
      "recovery-agent-call",
      { description: "Recovery search", prompt: "Second task that succeeds." },
      undefined,
      undefined,
      ctx,
    );
    expect(recovered.details.status).toBe("completed");
    expect(recovered.details.error).toBeUndefined();
    expect(recovered.details.result).toContain("recovery child done");

    disposeSession(session);
  });

  it("renders renderCall and renderResult with subagent type, description, and status", async () => {
    let captured: any;
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") {
          captured = tool;
        }
      },
      on: () => {},
      getThinkingLevel: () => "high",
    };
    const factory = createSubagentExtension();
    await factory(mockApi);
    expect(captured).toBeDefined();
    expect(captured.renderCall).toBeDefined();
    expect(captured.renderResult).toBeDefined();

    const theme = makeMockTheme();

    const callText = renderToText(
      captured.renderCall(
        { description: "Find auth files", subagent_type: "explorer", prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(callText).toContain("Agent");
    expect(callText).toContain("explorer");
    expect(callText).toContain("Find auth files");

    const partialCallText = renderToText(
      captured.renderCall(
        { prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(partialCallText).toContain("Agent");
    expect(partialCallText).not.toContain("undefined");

    const buildResult = (status: "completed" | "error" | "rejected") => ({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Find auth files",
        subagentType: "explorer" as const,
        status,
        ...(status === "completed" ? { result: "ok" } : { error: "fail" }),
      },
    });

    const completedText = renderToText(captured.renderResult(buildResult("completed"), {}, theme, {}));
    expect(completedText).toContain("Agent");
    expect(completedText).toContain("explorer");
    expect(completedText).toContain("Find auth files");
    expect(completedText).toContain("completed");

    const errorText = renderToText(captured.renderResult(buildResult("error"), {}, theme, {}));
    expect(errorText).toContain("error: fail");

    const rejectedText = renderToText(captured.renderResult(buildResult("rejected"), {}, theme, {}));
    expect(rejectedText).toContain("rejected: fail");

    const maxConcurrencyRejectedText = renderToText(captured.renderResult({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Optimize task253",
        subagentType: "general-purpose" as const,
        status: "rejected" as const,
        error: "Maximum subagent concurrency reached",
      },
    }, {}, theme, {}));
    expect(maxConcurrencyRejectedText).toContain("rejected: max concurrency reached");

    const unknownCallText = renderToText(
      captured.renderCall(
        { description: "Bad", subagent_type: "ghost", prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(unknownCallText).toContain("ghost");

    const executingCallText = renderToText(
      captured.renderCall(
        { description: "Find auth files", subagent_type: "explorer", prompt: "..." },
        theme,
        { executionStarted: true },
      ),
    );
    expect(executingCallText).toBe("");
  });

  it("renders compact progress with rolling activity and descriptions", async () => {
    let captured: any;
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") {
          captured = tool;
        }
      },
      on: () => {},
      getThinkingLevel: () => "high",
    };
    const factory = createSubagentExtension();
    await factory(mockApi);

    const theme = makeMockTheme();
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const result = {
        content: [{ type: "text" as const, text: "done" }],
        details: {
          description: "Research repo",
          subagentType: "explorer" as const,
          status: "running" as const,
          progress: {
            id: "root-progress",
            description: "Research repo",
            subagentType: "explorer" as const,
            status: "running" as const,
            startedAt: now - 2000,
            activity: ["Read src/types.ts", "Read app.py", "Read config.yaml"],
            activityCount: 5,
            usage: {
              input: 81_000,
              output: 4_900,
              cacheRead: 602_000,
              cacheWrite: 0,
              latestCacheHitRate: 94.666,
              cost: 0.85,
            },
          },
        },
      };

      const text = renderToText(captured.renderResult(result, {}, theme, {}));

      expect(text).toContain("Agent(explorer: Research repo)");
      expect(text).toContain("running 2s ↑81k ↓4.9k R602k CH94.7% $0.850");
      expect(text).toContain("... +2 earlier events");
      expect(text).toContain("Read src/types.ts");
      expect(text).toContain("Read app.py");
      expect(text).toContain("Read config.yaml");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("folds long progress activity lines only in the rendered subagent window", async () => {
    let captured: any;
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") {
          captured = tool;
        }
      },
      on: () => {},
      getThinkingLevel: () => "high",
    };
    const factory = createSubagentExtension();
    await factory(mockApi);

    const theme = makeMockTheme();
    const hiddenTail = "TAIL_MARKER_SHOULD_STAY_OUT_OF_RENDERED_PREVIEW";
    const longCommand = `bash uv run python - <<'PY' ${"print('long progress payload') ".repeat(30)}${hiddenTail} PY`;
    const result = {
      content: [{ type: "text" as const, text: "running" }],
      details: {
        description: "Long tool call",
        subagentType: "general-purpose" as const,
        status: "running" as const,
        progress: {
          id: "long-progress",
          description: "Long tool call",
          subagentType: "general-purpose" as const,
          status: "running" as const,
          startedAt: Date.now(),
          activity: [longCommand],
          activityCount: 1,
        },
      },
    };

    const text = renderToText(captured.renderResult(result, {}, theme, {}));

    expect(text).toContain("bash uv run python");
    expect(text).toContain("... (+");
    expect(text).toContain("chars)");
    expect(text).not.toContain(hiddenTail);
    expect(result.details.progress.activity[0]).toBe(longCommand);

    const narrowLines = captured
      .renderResult(result, {}, theme, {})
      .render(80)
      .map((line: string) => stripAnsi(line))
      .filter((line: string) => line.trim());
    expect(narrowLines).toHaveLength(2);
  });

  it("registers the Agent tool when loaded via additionalExtensionPaths", async () => {
    const registration = registerFauxProvider({
      models: [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }],
    });
    registrations.push(registration);

    const model = registration.getModel("faux-thinker") as Model<string>;
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    authStorage.setRuntimeApiKey(model.provider, "test-api-key");
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const settingsManager = SettingsManager.inMemory({});
    const sessionManager = SessionManager.inMemory(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "high",
      settingsManager,
      sessionManager,
      resourceLoader,
    });
    trackSession(session);
    await session.bindExtensions({});

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    expect(tool).toBeDefined();
    expect((tool?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty(
      "subagent_type",
    );

    disposeSession(session);
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

  describe("proactive routing scenarios", () => {
    function makeRouter(decide: (userText: string, systemPrompt: string) => unknown[] | string) {
      return (context: Context) => {
        const userText = context.messages
          .filter((message) => (message as { role?: string }).role === "user")
          .map((message) => JSON.stringify((message as { content?: unknown }).content))
          .join("\n");
        const systemPrompt = context.systemPrompt ?? "";
        const decision = decide(userText, systemPrompt);
        if (typeof decision === "string") {
          return fauxAssistantMessage(decision);
        }
        return fauxAssistantMessage(decision as never, { stopReason: "toolUse" });
      };
    }

    it("scenario 1: multi-repo research → coordinator-aware router fans out two parallel Agent calls", async () => {
      const { session, registration } = await createSession();
      let rootContext: Context | undefined;

      registration.setResponses([
        (context) => {
          rootContext = context;
          const userText = context.messages
            .filter((message) => (message as { role?: string }).role === "user")
            .map((message) => JSON.stringify((message as { content?: unknown }).content))
            .join("\n");
          const mentionsTwoRepos = /repo-a/.test(userText) && /repo-b/.test(userText);
          const promptSaysUseAgent = (context.systemPrompt ?? "").includes(
            "Reach for Agent when the task matches an available agent",
          );
          if (mentionsTwoRepos && promptSaysUseAgent) {
            return fauxAssistantMessage(
              [
                fauxToolCall("Agent", {
                  description: "Audit repo-a auth",
                  subagent_type: "explorer",
                  prompt: "Audit auth implementation under repo-a/. Report key files and flow.",
                }),
                fauxToolCall("Agent", {
                  description: "Audit repo-b auth",
                  subagent_type: "explorer",
                  prompt: "Audit auth implementation under repo-b/. Report key files and flow.",
                }),
              ],
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage("would not delegate");
        },
        fauxAssistantMessage("repo-a auth uses session cookies"),
        fauxAssistantMessage("repo-b auth uses JWT"),
        (context) => fauxAssistantMessage(`Compared: ${JSON.stringify(context.messages).slice(0, 50)}`),
      ]);

      await session.prompt("Compare how auth is implemented in repo-a/ and repo-b/.");

      expect(rootContext?.systemPrompt).toContain("Reach for Agent when the task matches an available agent");
      expect(rootContext?.systemPrompt).toContain("multiple Agent calls in the same assistant response");
      const finalSerialized = JSON.stringify(session.messages);
      expect(finalSerialized).toContain("repo-a auth uses session cookies");
      expect(finalSerialized).toContain("repo-b auth uses JWT");
      expect(finalSerialized).not.toContain("Maximum subagent concurrency reached");

      disposeSession(session);
    });

    it("scenario 2: broad codebase exploration → coordinator-aware router delegates to explorer", async () => {
      const { session, registration } = await createSession();

      registration.setResponses([
        makeRouter((userText, systemPrompt) => {
          const broad = /across this codebase|where is .* handled/i.test(userText);
          const explorerHinted = systemPrompt.includes("explorer") && systemPrompt.includes("locating files");
          if (broad && explorerHinted) {
            return [
              fauxToolCall("Agent", {
                description: "Locate rate limiting",
                subagent_type: "explorer",
                prompt: "Find every place rate limiting is implemented or referenced. Report files and symbols.",
              }),
            ];
          }
          return "no delegation";
        }),
        fauxAssistantMessage("found in src/middleware/rate-limit.ts and src/api/throttle.ts"),
        fauxAssistantMessage("Rate limiting lives in middleware/rate-limit.ts and api/throttle.ts."),
      ]);

      await session.prompt("Where is rate limiting handled across this codebase?");

      const serialized = JSON.stringify(session.messages);
      expect(serialized).toContain("rate-limit.ts");
      expect(registration.getPendingResponseCount()).toBe(0);

      disposeSession(session);
    });

    it("scenario 3: single-file lookup → router does NOT delegate", async () => {
      const { session, registration } = await createSession();

      registration.setResponses([
        makeRouter((userText, systemPrompt) => {
          const singleFile = /line \d+ of |what does .* in src\/.*\.(ts|js) do/i.test(userText);
          const knowsNotToDelegate = systemPrompt.includes(
            "single-fact lookup where you already know the file",
          );
          if (singleFile && knowsNotToDelegate) {
            return "Line 42 of src/foo.ts does X — answered directly without delegation.";
          }
          return [
            fauxToolCall("Agent", {
              description: "Should not happen",
              prompt: "delegated wrongly",
            }),
          ];
        }),
      ]);

      await session.prompt("What does line 42 of src/foo.ts do?");

      const serialized = JSON.stringify(session.messages);
      expect(serialized).toContain("answered directly without delegation");
      expect(serialized).not.toContain("delegated wrongly");
      expect(registration.getPendingResponseCount()).toBe(0);

      disposeSession(session);
    });

    it("scenario 4: explicit parallel audit → router emits multiple parallel Agent calls", async () => {
      const { session, registration } = await createSession();

      registration.setResponses([
        makeRouter((userText, systemPrompt) => {
          const fanOut = /parallel.*TODOs.*FIXMEs.*skipped tests/i.test(userText);
          const promptSaysParallel = systemPrompt.includes("multiple Agent calls");
          if (fanOut && promptSaysParallel) {
            return [
              fauxToolCall("Agent", { description: "Find TODOs", subagent_type: "explorer", prompt: "Grep for TODO." }),
              fauxToolCall("Agent", { description: "Find FIXMEs", subagent_type: "explorer", prompt: "Grep for FIXME." }),
              fauxToolCall("Agent", { description: "Find skipped tests", subagent_type: "explorer", prompt: "Grep for it.skip / xit / describe.skip." }),
            ];
          }
          return "no delegation";
        }),
        fauxAssistantMessage("3 TODOs"),
        fauxAssistantMessage("1 FIXME"),
        fauxAssistantMessage("2 skipped tests"),
        fauxAssistantMessage("Audit complete: 3 TODOs, 1 FIXME, 2 skipped tests."),
      ]);

      await session.prompt("In parallel, audit our code for TODOs, FIXMEs, and skipped tests.");

      const serialized = JSON.stringify(session.messages);
      expect(serialized).toContain("3 TODOs");
      expect(serialized).toContain("1 FIXME");
      expect(serialized).toContain("2 skipped tests");
      expect(registration.getPendingResponseCount()).toBe(0);

      disposeSession(session);
    });
  });
});
