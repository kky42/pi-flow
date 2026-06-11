import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// pi-coding-agent 0.77.0 carries its own pi-ai instance; faux providers must register there.

describe("pi-subagent", () => {
  let tempDir: string;
  let cwd: string;
  let agentDir: string;
  let registrations: Array<{ unregister: () => void }>;
  let sessions: Array<{ dispose: () => void }>;
  let originalAgentDirEnv: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tempDir, "project");
    agentDir = join(tempDir, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
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

  async function createSession(options: { maxWidth?: number } = {}) {
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
      extensionFactories: [createSubagentExtension(options)],
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

    return { session, registration, model, modelRegistry };
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

  function makeExecutionContext({
    hasUI,
    model,
    modelRegistry,
    tui = false,
  }: {
    hasUI: boolean;
    model: Model<string>;
    modelRegistry: ModelRegistry;
    tui?: boolean;
  }) {
    return {
      hasUI,
      cwd,
      model,
      modelRegistry,
      ui: {
        getAllThemes: () => (tui ? [{ name: "test", path: "test-theme.json" }] : []),
      },
    };
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
    expect(childContext?.tools?.some((tool: { name?: string }) => tool.name === "Agent")).toBe(false);
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
    });
    expect(profiles.get("explorer")?.description).toContain("Fast read-only search agent");
    expect(profiles.get("explorer")?.systemPrompt).toContain("Explorer Subagent Role");
  });

  it("loads custom subagent profiles from filename-derived names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-reviewer.md"), `---
description: Reviews code changes for correctness.
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

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("code-reviewer")).toMatchObject({
      name: "code-reviewer",
      description: "Reviews code changes for correctness.",
      thinking: "low",
      systemPrompt: "You are a careful code reviewer.",
    });
    expect(profiles.has("Bad Name")).toBe(false);
    expect(profiles.has("missing-description")).toBe(false);
    expect(profiles.has("bad-thinking")).toBe(false);
    expect(profiles.has("bad-model")).toBe(false);
    expect(profiles.has("general-purpose")).toBe(true);
    expect(profiles.has("explorer")).toBe(true);
  });

  it("runs a custom subagent with appended body prompt and thinking override", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-reviewer.md"), `---
description: Reviews code changes for correctness.
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
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBe("low");
    expect(JSON.stringify(childContext?.messages)).toContain("Review the latest diff.");

    disposeSession(session);
  });

  it("does not count an unavailable-profile-model rejection toward maxWidth", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "bad-model-agent.md"), `---
description: Uses an unavailable registered model.
model: ghost/nope
---

This should not be advertised or launched.`);

    const { session, registration } = await createSession({ maxWidth: 1 });
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
    expect(serialized).not.toContain("Maximum subagent width reached");

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

  it("enforces maxWidth for foreground parallel Agent calls", async () => {
    const { session, registration } = await createSession({ maxWidth: 1 });
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
    expect(serialized).toContain("Maximum subagent width reached");

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
    expect(rootContext?.systemPrompt).toContain("Subagents cannot launch other subagents");
    expect(rootContext?.systemPrompt).toContain("Root-level parallel delegation is bounded");
    expect(rootContext?.systemPrompt).not.toContain("max width 4");
    expect(rootContext?.systemPrompt).toContain("Available agents");
    expect(rootContext?.systemPrompt).toContain("general-purpose: General-purpose agent for researching complex questions");
    expect(rootContext?.systemPrompt).toContain("explorer: Fast read-only search agent");
    expect(rootContext?.systemPrompt).toContain("Reach for Agent when the task matches an available agent");
    expect(rootContext?.systemPrompt).toContain('User asks "explore this repo"');
    expect(rootContext?.systemPrompt).toContain("single-fact lookup");
    expect(rootContext?.systemPrompt).toContain("Once you delegate a search");

    disposeSession(session);
  });

  it("resets per-turn child count so a new user turn gets a fresh maxWidth budget", async () => {
    const { session, registration } = await createSession({ maxWidth: 1 });

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
    expect(serialized).not.toContain("Maximum subagent width reached");

    disposeSession(session);
  });

  it("releases completed subagents before later tool rounds in the same user prompt", async () => {
    const { session, registration } = await createSession({ maxWidth: 4 });

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
    expect(serialized).not.toContain("Maximum subagent width reached");

    disposeSession(session);
  });

  it("renders renderCall and renderResult with subagent type, description, and status", async () => {
    let captured: any;
    const mockApi: any = {
      registerTool: (tool: any) => {
        captured = tool;
      },
      on: () => {},
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

    const maxWidthRejectedText = renderToText(captured.renderResult({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Optimize task253",
        subagentType: "general-purpose" as const,
        status: "rejected" as const,
        error: "Maximum subagent width reached",
      },
    }, {}, theme, {}));
    expect(maxWidthRejectedText).toContain("rejected: max width reached");

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
        captured = tool;
      },
      on: () => {},
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
        captured = tool;
      },
      on: () => {},
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
      expect(finalSerialized).not.toContain("Maximum subagent width reached");

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
