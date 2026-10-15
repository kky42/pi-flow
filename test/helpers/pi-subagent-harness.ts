import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TerminalTaskEnvelope } from "../../src/core/task-manager.ts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxProviderHandle,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach } from "vitest";
import { createSubagentExtension } from "../../src/pi-subagent.ts";

export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * pi >= 1.2 delivers the effective prompt to providers as transcript system
 * messages (leading content plus named sections) instead of the pre-1.2
 * `Context.systemPrompt` shorthand. Reconstruct the text either way so tests
 * observe what the model actually sees.
 */
export function systemPromptFromProviderContext(context: Context | undefined): string {
  if (!context) return "";
  if (typeof context.systemPrompt === "string") return context.systemPrompt;
  const parts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    parts.push(typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    if (message.sections) {
      for (const section of Object.values(message.sections)) {
        if (section !== null) parts.push(section);
      }
    }
  }
  return parts.join("\n\n");
}

export type FauxModelDef = { id: string; name: string; reasoning: boolean };
export type TestFauxProvider = FauxProviderHandle & { unregister: () => void };
export type TaskEnvelope = {
  task_type: "agent" | "workflow";
  status: "completed" | "failed";
  label?: string;
  name?: string;
  session_key?: string;
  content?: string;
};
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type CreateSessionOptions = {
  extensionFactories?: ExtensionFactory[];
  onStatus?: (key: string, text: string | undefined) => void;
  onWidget?: (key: string, lines: string[] | undefined, placement: string | undefined) => void;
  maxConcurrentSubagents?: number;
  maxConcurrentSubagentsFlag?: string;
  subagentTimeoutMs?: number;
  subagentTimeoutMsFlag?: string;
  models?: FauxModelDef[];
  defaultModelId?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  mode?: "tui" | "rpc" | "json" | "print";
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
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

export function installFauxProvider(
  modelRegistry: ModelRegistry,
  faux: FauxProviderHandle,
): TestFauxProvider {
  const models: MutableModels = createModels();
  models.setProvider(faux.provider);
  modelRegistry.registerProvider(faux.provider.id, {
    api: faux.api,
    streamSimple: (model, context, streamOptions) => models.streamSimple(model, context, streamOptions),
  });
  return Object.assign(faux, {
    unregister: () => {
      modelRegistry.unregisterProvider(faux.provider.id);
      models.deleteProvider(faux.provider.id);
    },
  });
}

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
      extensionFactories = [],
      onStatus,
      onWidget,
      maxConcurrentSubagents,
      maxConcurrentSubagentsFlag,
      subagentTimeoutMs,
      subagentTimeoutMsFlag,
      models: modelDefs = DEFAULT_MODEL_DEFS,
      defaultModelId,
      thinkingLevel = "high",
      systemPrompt,
      mode = "tui",
      settings,
    } = options;
    const faux = fauxProvider({ models: modelDefs });
    const models = modelDefs.map((def) => faux.getModel(def.id) as Model<string>);
    const model = defaultModelId ? (faux.getModel(defaultModelId) as Model<string>) : models[0];

    writeModelsJson(models);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const registration = installFauxProvider(modelRegistry, faux);
    await modelRuntime.setRuntimeApiKey(model.provider, "test-api-key");
    registrations.push(registration);
    const settingsManager = SettingsManager.inMemory(settings ?? {});
    const sessionManager = SessionManager.inMemory(cwd);
    const extensionOptions = {
      ...(maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents }),
      ...(subagentTimeoutMs === undefined ? {} : { subagentTimeoutMs }),
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [createSubagentExtension(extensionOptions), ...extensionFactories],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
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
      modelRuntime,
      model,
      thinkingLevel,
      settingsManager,
      sessionManager,
      resourceLoader,
    });
    trackSession(session);
    const uiContext = onStatus || onWidget
      ? Object.create(session.extensionRunner.getUIContext(), {
          setStatus: { value: onStatus ?? (() => {}) },
          setWidget: {
            value: (key: string, content: unknown, options?: { placement?: string }) => {
              if (!onWidget) return;
              if (content === undefined) {
                onWidget(key, undefined, options?.placement);
                return;
              }
              if (Array.isArray(content)) {
                onWidget(key, content as string[], options?.placement);
                return;
              }
              const component = (content as (tui: unknown, theme: ReturnType<typeof makeMockTheme>) => { render: (width: number) => string[] })(
                { requestRender() {} },
                makeMockTheme(),
              );
              onWidget(key, component.render(200), options?.placement);
            },
          },
          theme: { value: makeMockTheme() },
        })
      : undefined;
    await session.bindExtensions({ mode, uiContext });

    return { session, registration, model, models, modelRegistry, modelRuntime, sessionManager };
  }

  function setContextRoutingResponses(
    registration: FauxProviderHandle,
    response: (context: Context, options: SimpleStreamOptions, model: Model<string>) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
    count = 32,
  ): void {
    registration.setResponses(Array.from({ length: count }, () =>
      (context: Context, options: SimpleStreamOptions | undefined, _state: unknown, model: Model<string>) =>
        response(context, options ?? {}, model),
    ));
  }

  function taskNotifications(session: { messages: readonly unknown[] }): TaskEnvelope[] {
    return session.messages
      .filter((message): message is { role: string; customType?: string; details?: unknown } =>
        typeof message === "object" && message !== null && "role" in message)
      .filter((message) => message.role === "custom" && message.customType === "pi-flow-task-notification")
      .map((message) => message.details as TaskEnvelope);
  }

  async function executeSubagentTask(
    session: { getToolDefinition: (name: string) => unknown; messages: readonly unknown[] },
    registration: FauxProviderHandle,
    context: unknown,
    toolArgs: Record<string, unknown>,
    childResponse: (context: Context, options: SimpleStreamOptions, model: Model<string>) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
  ) {
    setContextRoutingResponses(registration, (providerContext, options, model) =>
      childResponse(providerContext, options, model));
    const tool = session.getToolDefinition("run_agent") as {
      execute: (...args: unknown[]) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const result = await tool.execute("agent-test-call", toolArgs, undefined, undefined, context);
    const terminal = JSON.parse(result.content[0].text) as TaskEnvelope;
    return { result, terminal };
  }

  function makeMockTheme() {
    const theme = Object.create(Theme.prototype) as Theme;
    theme.fg = (_color, text) => text;
    theme.bold = (text) => text;
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
    onStatus,
    onWidget,
    projectTrusted = false,
    persistedSession = false,
    sessionManager,
  }: {
    hasUI: boolean;
    model: Model<string>;
    modelRegistry: ModelRegistry;
    tui?: boolean;
    onStatus?: (key: string, text: string | undefined) => void;
    onWidget?: (key: string, lines: string[] | undefined, placement: string | undefined) => void;
    projectTrusted?: boolean;
    persistedSession?: boolean;
    sessionManager?: SessionManager;
  }) {
    const theme = makeMockTheme();
    const sessionDir = join(tempDir, "sessions");
    return {
      hasUI,
      cwd,
      model,
      modelRegistry,
      sessionManager: sessionManager ?? (persistedSession
        ? {
            isPersisted: () => true,
            getSessionFile: () => join(sessionDir, "session.jsonl"),
            getSessionDir: () => sessionDir,
            getSessionId: () => "test-session",
          }
        : undefined),
      isProjectTrusted: () => projectTrusted,
      ui: {
        getAllThemes: () => (tui ? [{ name: "test", path: "test-theme.json" }] : []),
        setStatus: (key: string, text: string | undefined) => onStatus?.(key, text),
        setWidget: (key: string, lines: string[] | undefined, options?: { placement?: string }) =>
          onWidget?.(key, lines, options?.placement),
        theme,
      },
    };
  }

  function terminalEnvelope(result: { content: Array<{ text: string }> }): TerminalTaskEnvelope {
    return JSON.parse(result.content[0].text) as TerminalTaskEnvelope;
  }

  function getToolNames(context: Context | undefined): string[] {
    // pi >= 1.2 carries tool declarations on transcript system messages
    // (`toolsAdded`) instead of the pre-1.2 `Context.tools` shorthand.
    const transcriptTools = (context?.messages ?? []).flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool: { name?: string }) => tool?.name)
        : []);
    const names = context?.tools?.length
      ? context.tools.map((tool: { name?: string } | undefined) => tool?.name)
      : transcriptTools;
    return [...new Set(names.filter((name): name is string => typeof name === "string"))].sort();
  }

  return {
    trackSession,
    disposeSession,
    createSession,
    setContextRoutingResponses,
    taskNotifications,
    executeSubagentTask,
    terminalEnvelope,
    makeMockTheme,
    stripAnsi,
    renderToText,
    makeExecutionContext,
    getToolNames,
  };
}
