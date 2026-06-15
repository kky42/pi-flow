import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createProgressNode,
  extractFinalAssistantText,
  getSubagentUsage,
  PROGRESS_HEARTBEAT_INTERVAL_MS,
  PROGRESS_UPDATE_INTERVAL_MS,
  textResult,
  updateProgressFromEvent,
  type AgentToolResult,
} from "./progress.ts";
import type { SubagentProfile, SubagentUsage } from "../types.ts";

/**
 * Parameters for a single subagent run. This is the shared spawn primitive used
 * by both the `Agent` tool and (later) the `workflow` tool's `agent()` global.
 * Concurrency accounting lives in the callers, not here.
 */
export interface SpawnSubagentParams {
  toolCallId: string;
  description: string;
  prompt: string;
  profile: SubagentProfile;
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  progressEnabled: boolean;
  onProgress: ((result: AgentToolResult) => void) | undefined;
  onUsage: (usage: SubagentUsage) => void;
  /** Tools (and the extensions that provide them) to keep out of the child session. Defaults to ["Agent"]. */
  excludeTools?: readonly string[];
  /** Text appended after the task prompt (e.g. a structured-output contract). */
  appendInstructions?: string;
  /** Extra extension factories to register in the child session (e.g. a structured_output tool). */
  extraExtensionFactories?: ExtensionFactory[];
  /** Names of injected tools to keep enabled when a profile pins a tool allow-list. */
  extraToolNames?: readonly string[];
}

export async function spawnSubagent(params: SpawnSubagentParams): Promise<AgentToolResult> {
  const {
    toolCallId,
    description,
    prompt,
    profile,
    model,
    thinkingLevel,
    ctx,
    signal,
    progressEnabled,
    onProgress,
    onUsage,
  } = params;
  const subagentType = profile.name;
  const excludeTools = params.excludeTools ?? ["Agent"];
  const extraExtensionFactories = params.extraExtensionFactories ?? [];
  const extraToolNames = params.extraToolNames ?? [];
  // A pinned tool allow-list must still admit any injected tools (e.g. structured_output).
  const toolAllowList = profile.tools !== undefined ? [...profile.tools, ...extraToolNames] : undefined;
  const taskPrompt = params.appendInstructions ? `${prompt}\n\n${params.appendInstructions}` : prompt;
  const progress = progressEnabled ? createProgressNode(toolCallId, description, subagentType) : undefined;

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    profile.systemPrompt,
  ].filter((value): value is string => Boolean(value));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...(extraExtensionFactories.length > 0 ? { extensionFactories: extraExtensionFactories } : {}),
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (extension) => !excludeTools.some((name) => extension.tools.has(name)),
      ),
    }),
    appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel,
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    excludeTools: [...excludeTools],
    ...(toolAllowList !== undefined ? { tools: toolAllowList } : {}),
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      void session.abort();
    };
    if (!signal.aborted) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  let lastProgressEmit = 0;
  let pendingProgressTimer: ReturnType<typeof setTimeout> | undefined;
  let progressHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const emitProgress = () => {
    if (!progress || !onProgress) {
      return;
    }
    if (pendingProgressTimer) {
      clearTimeout(pendingProgressTimer);
      pendingProgressTimer = undefined;
    }
    lastProgressEmit = Date.now();
    onProgress(textResult(`Subagent "${description}" (${subagentType}) is running.`, {
      description,
      subagentType,
      status: progress.status,
      result: progress.result,
      error: progress.error,
      progress,
    }));
  };
  const emitProgressSoon = () => {
    const elapsed = Date.now() - lastProgressEmit;
    if (elapsed >= PROGRESS_UPDATE_INTERVAL_MS) {
      emitProgress();
      return;
    }
    if (!pendingProgressTimer) {
      pendingProgressTimer = setTimeout(() => {
        pendingProgressTimer = undefined;
        emitProgress();
      }, PROGRESS_UPDATE_INTERVAL_MS - elapsed);
    }
  };
  const startProgressHeartbeat = () => {
    if (!progress || !onProgress || progressHeartbeatTimer) {
      return;
    }
    progressHeartbeatTimer = setInterval(() => {
      emitProgressSoon();
    }, PROGRESS_HEARTBEAT_INTERVAL_MS);
    progressHeartbeatTimer.unref?.();
  };
  const stopProgressHeartbeat = () => {
    if (!progressHeartbeatTimer) {
      return;
    }
    clearInterval(progressHeartbeatTimer);
    progressHeartbeatTimer = undefined;
  };

  const unsubscribe = session.subscribe((event) => {
    if (progress) {
      updateProgressFromEvent(progress, event);
      emitProgressSoon();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = getSubagentUsage(session);
      if (progress) {
        progress.usage = usage;
      }
      onUsage(usage);
    }
  });

  try {
    if (signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    await session.bindExtensions({});
    if (signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    emitProgress();
    startProgressHeartbeat();
    await session.prompt(taskPrompt, { source: "extension" });
    const result = extractFinalAssistantText(session.messages) || "(no final text output)";
    const usage = getSubagentUsage(session);
    onUsage(usage);
    if (progress) {
      progress.status = "completed";
      progress.result = result;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${description}" (${subagentType}) completed:\n\n${result}`, {
      description,
      subagentType,
      status: "completed",
      result,
      usage,
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const usage = getSubagentUsage(session);
    onUsage(usage);
    if (progress) {
      progress.status = "error";
      progress.error = message;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${description}" (${subagentType}) failed: ${message}`, {
      description,
      subagentType,
      status: "error",
      error: message,
      usage,
      ...(progress ? { progress } : {}),
    });
  } finally {
    if (pendingProgressTimer) {
      clearTimeout(pendingProgressTimer);
    }
    stopProgressHeartbeat();
    unsubscribe?.();
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}
