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
} from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { afterEach, beforeEach } from "vitest";
import { createSubagentExtension } from "../../src/pi-subagent.ts";

export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type FauxModelDef = { id: string; name: string; reasoning: boolean };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type CreateSessionOptions = {
  maxConcurrentSubagents?: number;
  maxConcurrentSubagentsFlag?: string;
  subagentTimeoutMs?: number;
  subagentTimeoutMsFlag?: string;
  models?: FauxModelDef[];
  defaultModelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type HarnessState = {
  tempDir: string;
  cwd: string;
  agentDir: string;
  originalPathEnv: string | undefined;
  registrations: Array<{ unregister: () => void }>;
  sessions: Array<{ dispose: () => void }>;
};

const DEFAULT_MODEL_DEFS: FauxModelDef[] = [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }];

export function setupPiSubagentTestHarness(onSetup?: (state: HarnessState) => void) {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let registrations: Array<{ unregister: () => void }> = [];
  let sessions: Array<{ dispose: () => void }> = [];
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
    onSetup?.({ tempDir, cwd, agentDir, originalPathEnv, registrations, sessions });
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
    const {
      maxConcurrentSubagents,
      maxConcurrentSubagentsFlag,
      subagentTimeoutMs,
      subagentTimeoutMsFlag,
      models: modelDefs = DEFAULT_MODEL_DEFS,
      defaultModelId,
      thinkingLevel = "high",
    } = options;
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
    const extensionOptions = {
      ...(maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents }),
      ...(subagentTimeoutMs === undefined ? {} : { subagentTimeoutMs }),
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [createSubagentExtension(extensionOptions)],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    if (maxConcurrentSubagentsFlag !== undefined) {
      resourceLoader.getExtensions().runtime.flagValues.set("max-concurrent-subagents", maxConcurrentSubagentsFlag);
    }
    if (subagentTimeoutMsFlag !== undefined) {
      resourceLoader.getExtensions().runtime.flagValues.set("subagent-timeout-ms", subagentTimeoutMsFlag);
    }

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

  return {
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
  };
}
