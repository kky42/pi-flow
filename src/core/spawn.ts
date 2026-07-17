import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createProgressEmitter,
  extractFinalAssistantText,
  getFinalAssistantFailure,
  getSubagentUsage,
  textResult,
  updateProgressFromEvent,
  type AgentToolResult,
} from "./progress.ts";
import { spawnClaudeSubagent } from "./claude.ts";
import { spawnCodexSubagent } from "./codex.ts";
import type { SubagentProfile, SubagentToolDetails, SubagentUsage } from "../types.ts";
import { createTimeoutSignal, markSubagentTimedOut } from "./timeout.ts";

/**
 * The delegation tools a spawned child must never receive, so subagents cannot
 * recursively fan out. Owned by the spawn core and used as the default exclude
 * list so no caller can accidentally under-specify the nesting block.
 */
export const CHILD_EXCLUDED_TOOLS: readonly string[] = ["Agent", "workflow"];

const PI_SUBAGENT_SESSION_DIR_NAME = "subagent-sessions";

export function incrementalPiUsage(current: SubagentUsage, baseline: SubagentUsage): SubagentUsage {
  const input = Math.max(0, current.input - baseline.input);
  const output = Math.max(0, current.output - baseline.output);
  const cacheRead = Math.max(0, current.cacheRead - baseline.cacheRead);
  const cacheWrite = Math.max(0, current.cacheWrite - baseline.cacheWrite);
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: Math.max(0, current.cost - baseline.cost),
    costKnown: current.costKnown,
    latestCacheHitRate: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined,
  };
}

interface PiSubagentSessionResolution {
  sessionManager: SessionManager;
  sessionId: string | undefined;
}

async function resolvePiSubagentSession({
  cwd,
  agentDir,
  requestedSessionId,
}: {
  cwd: string;
  agentDir: string;
  requestedSessionId: string | undefined;
}): Promise<PiSubagentSessionResolution> {
  const sessionDir = join(agentDir, PI_SUBAGENT_SESSION_DIR_NAME);
  const normalizedSessionId = requestedSessionId?.trim();
  if (normalizedSessionId) {
    const sessions = await SessionManager.list(cwd, sessionDir);
    const existing = sessions.find((session) => session.id === normalizedSessionId);
    const sessionManager = existing
      ? SessionManager.open(existing.path, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id: normalizedSessionId });
    return {
      sessionManager,
      sessionId: sessionManager.getSessionId(),
    };
  }

  const sessionManager = SessionManager.create(cwd, sessionDir);
  return {
    sessionManager,
    sessionId: sessionManager.getSessionId(),
  };
}

/**
 * Parameters for a single subagent run. This is the shared spawn primitive used
 * by both the `Agent` tool and the `workflow` tool's `agent()` global.
 * Concurrency accounting lives in the callers, not here; callers acquire a slot
 * before invoking spawnSubagent, so the runtime timeout below excludes queue time.
 */
export interface SpawnSubagentParams {
  toolCallId: string;
  description: string;
  prompt: string;
  profile: SubagentProfile;
  model?: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: string | undefined;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  /** Maximum wall-clock runtime once this spawn starts. Set 0 to disable. */
  timeoutMs: number;
  progressEnabled: boolean;
  onProgress: ((result: AgentToolResult) => void) | undefined;
  onUsage: (usage: SubagentUsage) => void;
  /** Tools (and the extensions that provide them) to keep out of the child session. Defaults to {@link CHILD_EXCLUDED_TOOLS}. */
  excludeTools?: readonly string[];
  /** Text appended after the task prompt (e.g. a structured-output contract). */
  appendInstructions?: string;
  /** Extra tools to register in the child session (e.g. a structured_output tool). */
  customTools?: ToolDefinition[];
  /** Backend session/thread id resolved from a caller-facing session_key. */
  sessionId?: string;
  /** Persist the child session so a session_key can continue it later. */
  persistSession?: boolean;
  /** JSON schema for CLI backends that can validate final text output natively. */
  outputSchema?: unknown;
}

function rewriteTimeoutResult(
  result: AgentToolResult,
  params: { description: string; profile: SubagentProfile; timeoutMs: number },
): AgentToolResult {
  const details = markSubagentTimedOut(result.details as SubagentToolDetails, params.timeoutMs);
  const message = details.error;
  return textResult(`Subagent "${params.description}" (${params.profile.name}) aborted: ${message}`, {
    ...details,
    description: params.description,
    subagentType: params.profile.name,
    backend: params.profile.backend,
    status: "aborted",
  });
}

export async function spawnSubagent(params: SpawnSubagentParams): Promise<AgentToolResult> {
  const timeout = createTimeoutSignal(params.signal, params.timeoutMs, params.description);
  let result: AgentToolResult;
  try {
    result = await spawnSubagentRuntime({ ...params, signal: timeout.signal });
  } finally {
    timeout.cleanup();
  }
  return timeout.timedOut()
    ? rewriteTimeoutResult(result, {
        description: params.description,
        profile: params.profile,
        timeoutMs: params.timeoutMs,
      })
    : result;
}

async function spawnSubagentRuntime(params: SpawnSubagentParams): Promise<AgentToolResult> {
  if (params.profile.backend === "codex") {
    return spawnCodexSubagent({
      toolCallId: params.toolCallId,
      description: params.description,
      prompt: params.prompt,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      ctx: params.ctx,
      signal: params.signal,
      progressEnabled: params.progressEnabled,
      onProgress: params.onProgress,
      onUsage: params.onUsage,
      appendInstructions: params.appendInstructions,
      sessionId: params.sessionId,
      persistSession: params.persistSession === true,
      outputSchema: params.outputSchema,
    });
  }
  if (params.profile.backend === "claude") {
    return spawnClaudeSubagent({
      toolCallId: params.toolCallId,
      description: params.description,
      prompt: params.prompt,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      ctx: params.ctx,
      signal: params.signal,
      progressEnabled: params.progressEnabled,
      onProgress: params.onProgress,
      onUsage: params.onUsage,
      appendInstructions: params.appendInstructions,
      sessionId: params.sessionId,
      persistSession: params.persistSession === true,
      outputSchema: params.outputSchema,
    });
  }
  if (!params.model) {
    return textResult(`Subagent "${params.description}" (${params.profile.name}) failed: No model is selected.`, {
      description: params.description,
      subagentType: params.profile.name,
      backend: params.profile.backend,
      status: "error",
      error: "No model is selected",
    });
  }
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
  const excludeTools = params.excludeTools ?? CHILD_EXCLUDED_TOOLS;
  const customTools = params.customTools ?? [];
  // A pinned tool allow-list must still admit any injected tools (e.g. structured_output).
  const toolAllowList =
    profile.tools !== undefined ? [...profile.tools, ...customTools.map((tool) => tool.name)] : undefined;
  const taskPrompt = params.appendInstructions ? `${prompt}\n\n${params.appendInstructions}` : prompt;
  const emitter = createProgressEmitter({
    toolCallId,
    description,
    subagentType,
    backend: profile.backend,
    enabled: progressEnabled,
    onProgress,
  });
  const progress = emitter.progress;

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  let childSession: PiSubagentSessionResolution;
  try {
    childSession = params.persistSession === true
      ? await resolvePiSubagentSession({
          cwd,
          agentDir,
          requestedSessionId: params.sessionId,
        })
      : { sessionManager: SessionManager.inMemory(cwd), sessionId: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Subagent "${description}" (${subagentType}) failed: ${message}`, {
      description,
      subagentType,
      backend: profile.backend,
      status: "error",
      error: message,
    });
  }
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    profile.systemPrompt,
  ].filter((value): value is string => Boolean(value));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
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
    thinkingLevel: thinkingLevel as NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"],
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: childSession.sessionManager,
    resourceLoader,
    excludeTools: [...excludeTools],
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(toolAllowList !== undefined ? { tools: toolAllowList } : {}),
  });

  // Resumed Pi sessions expose lifetime stats. Keep the pre-prompt totals so
  // this invocation reports only its incremental usage to workflow aggregation.
  const usageBaseline = getSubagentUsage(session);
  const getCallUsage = () => incrementalPiUsage(getSubagentUsage(session), usageBaseline);

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      void session.abort();
    };
    if (!signal.aborted) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const unsubscribe = session.subscribe((event) => {
    if (progress) {
      updateProgressFromEvent(progress, event);
      emitter.emitSoon();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = getCallUsage();
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
    emitter.emit();
    emitter.startHeartbeat();
    await session.prompt(taskPrompt, { source: "extension" });
    // pi-ai encodes model/request failures (rate limits, quota exhaustion,
    // provider errors) as a final assistant turn with stopReason "error"/
    // "aborted" instead of throwing, so prompt() resolves even when nothing was
    // produced. Treat that terminal failure as an error rather than reporting a
    // hollow "(no final text output)" success.
    const failure = getFinalAssistantFailure(session.messages);
    if (failure) {
      // The catch below derives the reported status from whether OUR signal
      // aborted (signal?.aborted ? "aborted" : "error"), so a provider-reported
      // stopReason "aborted" that we did not trigger is surfaced as an error.
      // Keep this fallback message status-neutral — quote the stopReason as a
      // diagnostic detail rather than asserting the run was "aborted".
      throw new Error(
        failure.errorMessage || `Subagent model turn did not complete (stopReason: ${failure.stopReason}).`,
      );
    }
    const result = extractFinalAssistantText(session.messages) || "(no final text output)";
    const usage = getCallUsage();
    onUsage(usage);
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${description}" (${subagentType}) completed:\n\n${result}`, {
      description,
      subagentType,
      backend: profile.backend,
      status: "done",
      result,
      usage,
      ...(childSession.sessionId ? { sessionId: childSession.sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = signal?.aborted ? "aborted" : "error";
    const usage = getCallUsage();
    onUsage(usage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    const verb = status === "aborted" ? "aborted" : "failed";
    return textResult(`Subagent "${description}" (${subagentType}) ${verb}: ${message}`, {
      description,
      subagentType,
      backend: profile.backend,
      status,
      error: message,
      usage,
      ...(childSession.sessionId ? { sessionId: childSession.sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    unsubscribe?.();
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}
