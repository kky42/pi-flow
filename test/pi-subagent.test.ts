import { mkdirSync, rmSync } from "node:fs";
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// pi-coding-agent 0.77.0 carries its own pi-ai instance; faux providers must register there.

describe("pi-subagent", () => {
  let tempDir: string;
  let cwd: string;
  let agentDir: string;
  let registrations: Array<{ unregister: () => void }>;
  let sessions: Array<{ dispose: () => void }>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tempDir, "project");
    agentDir = join(tempDir, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
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

  async function createSession(options: { maxDepth?: number; maxWidth?: number } = {}) {
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
    expect(tool?.description).toContain("ship-readiness audits");
    expect(tool?.description).toContain("second opinions on risky migrations");
    expect(tool?.promptGuidelines).toContain(
      "Default to Agent for broad repo audits, cross-repo comparisons, independent checklist searches, and second opinions on risky migrations.",
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
    expect(childContext?.systemPrompt).toContain("delegation depth and width are bounded");
    expect(childContext?.systemPrompt).not.toContain("max depth 2");
    expect(childContext?.systemPrompt).not.toContain("max width 4");
    expect(JSON.stringify(childContext?.messages)).toContain("Search for the auth flow");
    expect(JSON.stringify(childContext?.messages)).not.toContain("Please delegate the auth search");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("found auth.ts");

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
    expect(childContext?.systemPrompt).toContain("Subagent Delegation");
    expect(JSON.stringify(childContext?.messages)).toContain("Inspect config loading.");

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
    const originalArgv = process.argv.slice();

    registration.setResponses([
      fauxAssistantMessage("config found"),
    ]);

    process.argv.push("--mode", "rpc");
    try {
      await tool.execute(
        "rpc-agent-call",
        {
          description: "Research config",
          prompt: "Inspect config loading.",
        },
        undefined,
        (result: unknown) => updateEvents.push(result),
        {
          hasUI: true,
          cwd,
          model,
          modelRegistry,
        },
      );
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }

    expect(updateEvents).toEqual([]);

    disposeSession(session);
  });

  it("keeps same-description parallel child progress nodes separate", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;

    registration.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "Same audit",
          prompt: "First nested task.",
        }),
        fauxToolCall("Agent", {
          description: "Same audit",
          prompt: "Second nested task.",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("first nested done"),
      fauxAssistantMessage("second nested done"),
      fauxAssistantMessage("parent done"),
    ]);

    const result = await tool.execute(
      "parent-progress",
      {
        description: "Parent audit",
        prompt: "Spawn two same-description nested agents.",
      },
      undefined,
      () => {},
      {
        hasUI: true,
        cwd,
        model,
        modelRegistry,
      },
    );

    const children = result.details.progress?.children ?? [];
    expect(children).toHaveLength(2);
    expect(children.map((child: { description: string }) => child.description)).toEqual([
      "Same audit",
      "Same audit",
    ]);
    expect(new Set(children.map((child: { id: string }) => child.id)).size).toBe(2);

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

  it("enforces maxDepth for nested Agent calls", async () => {
    const { session, registration } = await createSession({ maxDepth: 1 });
    let childContinuationContext: Context | undefined;
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Outer search",
        prompt: "Call a nested Agent for the next step.",
      })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Nested search",
        prompt: "This nested call should be rejected by maxDepth.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContinuationContext = context;
        return fauxAssistantMessage("nested depth rejection observed");
      },
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    await session.prompt("Run a nested Agent call.");

    expect(JSON.stringify(childContinuationContext?.messages)).toContain("Maximum subagent depth reached");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("nested depth rejection observed");
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
    expect(rootContext?.systemPrompt).toContain("delegation depth and width are bounded");
    expect(rootContext?.systemPrompt).not.toContain("max depth 2");
    expect(rootContext?.systemPrompt).not.toContain("max width 4");
    expect(rootContext?.systemPrompt).toContain("Use Agent proactively");
    expect(rootContext?.systemPrompt).toContain("Default to Agent for broad surveys");
    expect(rootContext?.systemPrompt).toContain("ship-readiness audits");
    expect(rootContext?.systemPrompt).toContain("Comparing the same concern across two repositories");
    expect(rootContext?.systemPrompt).toContain("TODOs, FIXMEs, skipped tests");
    expect(rootContext?.systemPrompt).toContain("User asks \"What's left before this branch can ship?\"");

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

  it("isolates per-parent width budgets across nested subagents", async () => {
    const { session, registration } = await createSession({ maxDepth: 2, maxWidth: 1 });

    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Outer", prompt: "Spawn one nested child." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Nested", prompt: "Inner work." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("nested leaf done"),
      fauxAssistantMessage("outer done"),
      fauxAssistantMessage("root done"),
    ]);

    await session.prompt("Spawn outer with one nested child.");

    const serialized = JSON.stringify(session.messages);
    expect(serialized).toContain("outer done");
    expect(serialized).not.toContain("Maximum subagent width reached");
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("rejects all delegation when maxDepth is 0", async () => {
    const { session, registration } = await createSession({ maxDepth: 0 });
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Disabled", prompt: "Should be rejected." })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("saw rejection");
      },
    ]);

    await session.prompt("Try delegating with maxDepth=0.");

    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("Maximum subagent depth reached");
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("allows nesting up to maxDepth and rejects beyond it", async () => {
    const { session, registration } = await createSession({ maxDepth: 2, maxWidth: 4 });
    let depth2Continuation: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Depth1", prompt: "Spawn depth-2." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Depth2", prompt: "Try depth-3." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Depth3", prompt: "Should be rejected." })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        depth2Continuation = context;
        return fauxAssistantMessage("saw depth-3 rejection");
      },
      fauxAssistantMessage("depth-1 done"),
      fauxAssistantMessage("root done"),
    ]);

    await session.prompt("Spawn three deep.");

    expect(JSON.stringify(depth2Continuation?.messages)).toContain("Maximum subagent depth reached");
    expect(registration.getPendingResponseCount()).toBe(0);

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
        depth: 1,
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
    expect(errorText).toContain("error");

    const rejectedText = renderToText(captured.renderResult(buildResult("rejected"), {}, theme, {}));
    expect(rejectedText).toContain("rejected");

    const unknownCallText = renderToText(
      captured.renderCall(
        { description: "Bad", subagent_type: "ghost", prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(unknownCallText).toContain("unknown");

    const executingCallText = renderToText(
      captured.renderCall(
        { description: "Find auth files", subagent_type: "explorer", prompt: "..." },
        theme,
        { executionStarted: true },
      ),
    );
    expect(executingCallText).toBe("");
  });

  it("renders compact nested progress with rolling activity and descriptions", async () => {
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
          depth: 1,
          status: "running" as const,
          progress: {
            id: "root-progress",
            description: "Research repo",
            subagentType: "explorer" as const,
            depth: 1,
            status: "running" as const,
            startedAt: now - 2000,
            activity: ["Read src/types.ts", "Read app.py", "Read config.yaml"],
            activityCount: 5,
            children: [
              {
                id: "nested-progress",
                description: "Nested audit",
                subagentType: "general-purpose" as const,
                depth: 2,
                status: "completed" as const,
                startedAt: now - 4000,
                endedAt: now - 1000,
                activity: ["checked nested files"],
                activityCount: 1,
                children: [],
                result: "nested done",
              },
              {
                id: "error-progress",
                description: "",
                subagentType: "general-purpose" as const,
                depth: 2,
                status: "error" as const,
                startedAt: now - 5000,
                endedAt: now - 2000,
                activity: [],
                activityCount: 0,
                children: [],
                error: "nested failed",
              },
            ],
          },
        },
      };

      const text = renderToText(captured.renderResult(result, {}, theme, {}));

      expect(text).toContain("Agent(explorer: Research repo)");
      expect(text).toContain("running 2s");
      expect(text).toContain("... +2 earlier events");
      expect(text).toContain("Read src/types.ts");
      expect(text).toContain("Read app.py");
      expect(text).toContain("Read config.yaml");
      expect(text).toContain("Agent(general-purpose: Nested audit)");
      expect(text).toContain("done 3s");
      expect(text).toContain("checked nested files");
      expect(text).toContain("Agent(general-purpose) error 3s");
      expect(text).toContain("nested failed");
    } finally {
      dateNow.mockRestore();
    }
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
          const promptSaysProactive = (context.systemPrompt ?? "").includes("Use Agent proactively");
          if (mentionsTwoRepos && promptSaysProactive) {
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

      expect(rootContext?.systemPrompt).toContain("Use Agent proactively");
      expect(rootContext?.systemPrompt).toContain("multiple Agent tool calls in the same assistant response");
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
          const explorerHinted = systemPrompt.includes("explorer") && systemPrompt.includes("file search");
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
            "Do not use Agent for a single-file read",
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

    it("scenario 4: fan-out audit → router emits multiple parallel Agent calls", async () => {
      const { session, registration } = await createSession();

      registration.setResponses([
        makeRouter((userText, systemPrompt) => {
          const fanOut = /audit .* TODOs.*FIXMEs.*skipped tests/i.test(userText);
          const promptSaysParallel = systemPrompt.includes("multiple Agent tool calls");
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

      await session.prompt("Audit our code for TODOs, FIXMEs, and skipped tests.");

      const serialized = JSON.stringify(session.messages);
      expect(serialized).toContain("3 TODOs");
      expect(serialized).toContain("1 FIXME");
      expect(serialized).toContain("2 skipped tests");
      expect(registration.getPendingResponseCount()).toBe(0);

      disposeSession(session);
    });
  });
});
