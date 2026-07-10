import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  AGENT_PROMPT_GUIDELINES,
  AGENT_PROMPT_SNIPPET,
  buildCoordinatorPrompt,
  buildWorkflowPrompt,
} from "./prompts.ts";
import { getSubagentProfiles } from "./profiles.ts";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import { getBackendAgentLabel } from "./core/display.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "./core/model.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import { createProgressNode, textResult, type AgentToolResult } from "./core/progress.ts";
import { formatUsage, renderSubagentNode } from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
import {
  assertBindingMatchesProfile,
  getPersistedSessionKeyBinding,
  normalizeSessionKey,
  persistSessionKeyBinding,
  SessionKeyLocks,
  type SessionKeyBinding,
} from "./core/session-key.ts";
import { createWorkflowTool } from "./workflow/tool.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";
import type {
  SubagentBackend,
  SubagentExtensionOptions,
  SubagentProfile,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentType,
  SubagentUsage,
} from "./types.ts";

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 12;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT_SUBAGENTS_FLAG = "max-concurrent-subagents";
const SUBAGENT_TIMEOUT_MS_FLAG = "subagent-timeout-ms";
const STATUS_KEY = "pi-flow";

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

const agentToolParameters = Type.Object({
  description: Type.String({
    description: "A short 3-5 word description of the task, used for UI display and routing context.",
  }),
  prompt: Type.String({
    description: "The self-contained task briefing to send to the subagent.",
  }),
  subagent_type: Type.Optional(
    Type.String({
      description: "The subagent profile to use. Defaults to general-purpose. Custom profiles are loaded from ~/.pi/agent/subagents/<agent-name>.md.",
    }),
  ),
  session_key: Type.Optional(
    Type.String({
      description: "Caller-chosen key for a resumable subagent conversation. Omit for a fresh one-shot subagent; reuse the same key to continue that child context.",
    }),
  ),
});

type AgentToolParams = Static<typeof agentToolParameters>;

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  progressEnabled: boolean;
  activeRuns: Map<string, ActiveAgentRun>;
  sessionBindings: Map<string, SessionKeyBinding>;
  sessionKeyLocks: SessionKeyLocks;
  frame: number;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface ActiveAgentRun {
  toolCallId: string;
  progress: SubagentProgressNode;
  onUpdate: ((result: AgentToolResult) => void) | undefined;
}

interface SubagentUsageStatusState {
  calls: Map<string, SubagentUsage>;
}

interface CreateAgentToolOptions {
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
}

const PROGRESS_STATUSES: SubagentProgressNode["status"][] = ["queued", "running", "done", "error", "aborted"];
const SUBAGENT_BACKENDS: SubagentBackend[] = ["pi", "codex", "claude"];

function shouldEnableProgress(ctx: ExtensionContext): boolean {
  if (!ctx.hasUI) {
    return false;
  }
  try {
    // RPC exposes ExtensionUIContext but has no TUI theme surface. Keep compact
    // progress updates limited to the interactive TUI renderer.
    return ctx.ui.getAllThemes().length > 0;
  } catch {
    return false;
  }
}

function normalizeMaxConcurrentSubagents(value: number | string | boolean | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeSubagentTimeoutMs(value: number | string | boolean | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeSubagentType(value: string | undefined): SubagentType {
  if (value === undefined || value.trim() === "") {
    return "general-purpose";
  }
  return value.trim();
}

function getSessionKeyBinding(
  state: DelegationState,
  ctx: ExtensionContext,
  sessionKey: string,
): SessionKeyBinding | undefined {
  const persisted = getPersistedSessionKeyBinding(ctx, sessionKey);
  if (persisted) {
    state.sessionBindings.set(sessionKey, persisted);
    return persisted;
  }
  return state.sessionBindings.get(sessionKey);
}

function rememberSessionKeyBinding(
  state: DelegationState,
  ctx: ExtensionContext,
  binding: SessionKeyBinding,
): void {
  const existing = getSessionKeyBinding(state, ctx, binding.key);
  state.sessionBindings.set(binding.key, binding);
  if (
    existing?.sessionId === binding.sessionId &&
    existing.subagentType === binding.subagentType &&
    existing.backend === binding.backend
  ) {
    return;
  }
  persistSessionKeyBinding(ctx, binding);
}

function formatProfileNames(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.keys()].join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isProgressStatus(value: unknown): value is SubagentProgressNode["status"] {
  return typeof value === "string" && PROGRESS_STATUSES.includes(value as SubagentProgressNode["status"]);
}

function isSubagentBackend(value: unknown): value is SubagentBackend {
  return typeof value === "string" && SUBAGENT_BACKENDS.includes(value as SubagentBackend);
}

function isSubagentProgressNode(value: unknown): value is SubagentProgressNode {
  if (!isRecord(value)) {
    return false;
  }
  const subagentType = value.subagentType;
  return (
    typeof value.id === "string" &&
    typeof value.description === "string" &&
    typeof subagentType === "string" &&
    (value.backend === undefined || isSubagentBackend(value.backend)) &&
    isProgressStatus(value.status) &&
    Number.isFinite(value.startedAt) &&
    Array.isArray(value.activity) &&
    value.activity.every((line) => typeof line === "string") &&
    Number.isFinite(value.activityCount)
  );
}

function getProfileBackend(subagentType: SubagentType | "unknown"): SubagentBackend | undefined {
  if (subagentType === "unknown") {
    return undefined;
  }
  return getSubagentProfiles(getAgentDir()).get(subagentType)?.backend;
}

function createUsageStatusState(): SubagentUsageStatusState {
  return {
    calls: new Map(),
  };
}

function getUsageTotals(state: SubagentUsageStatusState): SubagentUsage {
  const totals: SubagentUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const usage of state.calls.values()) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost;
    if (usage.costKnown === false) {
      totals.costKnown = false;
    }
  }
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  totals.latestCacheHitRate = promptTokens > 0 ? (totals.cacheRead / promptTokens) * 100 : undefined;
  return totals;
}

function formatUsageStatus(totals: SubagentUsage, theme: Theme): string {
  return `${theme.fg("dim", "pi-flow ")}${theme.fg("dim", formatUsage(totals))}`;
}

function publishUsageStatus(ctx: ExtensionContext, state: SubagentUsageStatusState): void {
  const totals = getUsageTotals(state);
  if (totals.input === 0 && totals.output === 0 && totals.cacheRead === 0 && totals.cacheWrite === 0 && totals.cost === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, formatUsageStatus(totals, ctx.ui.theme));
}

function updateUsageStatus(
  state: SubagentUsageStatusState,
  ctx: ExtensionContext,
  toolCallId: string,
  usage: SubagentUsage,
): void {
  state.calls.set(toolCallId, usage);
  publishUsageStatus(ctx, state);
}

function getRunningRunCount(state: DelegationState): number {
  let count = 0;
  for (const run of state.activeRuns.values()) {
    if (run.progress.status === "running") {
      count++;
    }
  }
  return count;
}

function emitActiveRunUpdate(state: DelegationState, run: ActiveAgentRun): void {
  run.onUpdate?.(textResult(`Subagent "${run.progress.description}" (${run.progress.subagentType}) ${run.progress.status}.`, {
    description: run.progress.description,
    subagentType: run.progress.subagentType,
    backend: run.progress.backend,
    status: run.progress.status,
    result: run.progress.result,
    error: run.progress.error,
    usage: run.progress.usage,
    progress: run.progress,
    activeCount: getRunningRunCount(state),
    frame: state.frame,
  }));
}

function broadcastActiveRunUpdates(state: DelegationState): void {
  for (const run of state.activeRuns.values()) {
    emitActiveRunUpdate(state, run);
  }
}

function startAgentHeartbeat(state: DelegationState): void {
  if (state.heartbeat) {
    return;
  }
  state.heartbeat = setInterval(() => {
    if (state.activeRuns.size === 0) {
      if (state.heartbeat) {
        clearInterval(state.heartbeat);
        state.heartbeat = undefined;
      }
      return;
    }
    state.frame++;
    broadcastActiveRunUpdates(state);
  }, SPINNER_INTERVAL_MS);
  state.heartbeat.unref?.();
}

function createAgentTool(
  getState: () => DelegationState,
  options: CreateAgentToolOptions,
): ToolDefinition<typeof agentToolParameters, SubagentToolDetails> {
  return defineTool({
    name: "Agent",
    label: "Agent",
    description: "Launch a subagent. Omit session_key for a fresh one-shot context; pass a caller-chosen session_key to create or continue a resumable subagent conversation. Available agents include built-ins and custom profiles from ~/.pi/agent/subagents/*.md.",
    promptSnippet: AGENT_PROMPT_SNIPPET,
    promptGuidelines: AGENT_PROMPT_GUIDELINES,
    parameters: agentToolParameters,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const state = getState();
      const effectiveState: DelegationState = {
        ...state,
        progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
      };
      const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const subagentType = normalizeSubagentType(params.subagent_type);
      const sessionKey = normalizeSessionKey(params.session_key);
      const profile = profiles.get(subagentType);
      if (!profile) {
        return textResult(
          `Unknown subagent_type "${params.subagent_type}". Available agents: ${formatProfileNames(profiles)}.`,
          {
            description: params.description,
            subagentType: "unknown",
            status: "error",
            error: "Unknown subagent_type",
          },
        );
      }

      const model = resolveProfileModel(profile, ctx);
      if (usesPiBackend(profile) && !model) {
        const error = profile.model ? `Profile model not found: ${profile.model}` : "No model is selected";
        return textResult(`Cannot launch subagent: ${error}.`, {
          description: params.description,
          subagentType,
          backend: profile.backend,
          status: "error",
          error,
        });
      }

      const progress = effectiveState.progressEnabled
        ? createProgressNode(toolCallId, params.description, subagentType, "queued", profile.backend)
        : undefined;
      const run = progress ? { toolCallId, progress, onUpdate } : undefined;
      if (run) {
        state.activeRuns.set(toolCallId, run);
        startAgentHeartbeat(state);
        broadcastActiveRunUpdates(state);
      }

      let release: (() => void) | undefined;
      const acquireSlot = async (): Promise<AgentToolResult | undefined> => {
        try {
          release = await state.limiter.acquire(signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = signal?.aborted ? "aborted" : "error";
          if (run) {
            run.progress.status = status;
            run.progress.error = message;
            run.progress.endedAt = Date.now();
            emitActiveRunUpdate(state, run);
          }
          return textResult(`Subagent "${params.description}" (${subagentType}) ${status}: ${message}`, {
            description: params.description,
            subagentType,
            backend: profile.backend,
            status,
            error: message,
          });
        }

        if (run) {
          run.progress.status = "running";
          run.progress.startedAt = Date.now();
          broadcastActiveRunUpdates(state);
        }
        return undefined;
      };

      try {
        let result: AgentToolResult;
        try {
          result = await state.sessionKeyLocks.run(sessionKey, async () => {
            const binding = sessionKey ? getSessionKeyBinding(state, ctx, sessionKey) : undefined;
            if (binding) {
              assertBindingMatchesProfile(binding, { subagentType, backend: profile.backend });
            }
            const acquisitionFailure = await acquireSlot();
            if (acquisitionFailure) {
              return acquisitionFailure;
            }
            const spawned = await spawnSubagent({
              toolCallId,
              description: params.description,
              prompt: params.prompt,
              profile,
              model,
              thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
              ctx,
              signal,
              timeoutMs: options.getSubagentTimeoutMs(),
              progressEnabled: effectiveState.progressEnabled,
              onProgress: effectiveState.progressEnabled && run
                ? (partial) => {
                    const details = partial.details as SubagentToolDetails;
                    if (details.progress) {
                      run.progress = details.progress;
                    }
                    emitActiveRunUpdate(state, run);
                  }
                : undefined,
              onUsage: (usage) => options.updateStatus(ctx, toolCallId, usage),
              excludeTools: CHILD_EXCLUDED_TOOLS,
              sessionId: binding?.sessionId,
              persistSession: Boolean(sessionKey),
            });
            const spawnedDetails = spawned.details as SubagentToolDetails;
            if (sessionKey && spawnedDetails.sessionId) {
              rememberSessionKeyBinding(state, ctx, {
                key: sessionKey,
                sessionId: spawnedDetails.sessionId,
                subagentType,
                backend: profile.backend,
              });
            }
            return spawned;
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (run) {
            run.progress.status = "error";
            run.progress.error = message;
            run.progress.endedAt = Date.now();
          }
          result = textResult(`Subagent "${params.description}" (${subagentType}) failed: ${message}`, {
            description: params.description,
            subagentType,
            backend: profile.backend,
            status: "error",
            error: message,
          });
        }
        const details = { ...(result.details as SubagentToolDetails) };
        delete details.sessionId;
        if (run && details.progress) {
          run.progress = details.progress;
        }
        if (run) {
          details.progress = run.progress;
          details.activeCount = getRunningRunCount(state);
          details.frame = state.frame;
        }
        return { ...result, details };
      } finally {
        release?.();
        if (run) {
          state.activeRuns.delete(toolCallId);
          broadcastActiveRunUpdates(state);
        }
      }
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const subagentType = normalizeSubagentType(args.subagent_type);
      const backend = getProfileBackend(subagentType);
      const description = typeof args.description === "string" ? args.description.trim() : "";
      return new Text(
        `${theme.bold(getBackendAgentLabel(backend))} ${theme.fg("muted", subagentType)}${description ? ` ${theme.fg("dim", description)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as SubagentToolDetails;
      return renderSubagentNode(
        details.progress ?? {
          description: details.description,
          subagentType: details.subagentType,
          backend: details.backend,
          status: details.status,
          result: details.result,
          error: details.error,
          usage: details.usage,
        },
        theme,
        details.frame ?? 0,
        details.activeCount ?? (details.status === "running" ? 1 : 0),
      );
    },
  });
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
  const defaultMaxConcurrentSubagents = normalizeMaxConcurrentSubagents(
    options.maxConcurrentSubagents,
    DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    "maxConcurrentSubagents",
  );
  const defaultSubagentTimeoutMs = normalizeSubagentTimeoutMs(
    options.subagentTimeoutMs,
    DEFAULT_SUBAGENT_TIMEOUT_MS,
    "subagentTimeoutMs",
  );
  const workflowEnabled = options.workflow !== false;

  return function subagentExtension(pi: ExtensionAPI) {
    pi.registerFlag(MAX_CONCURRENT_SUBAGENTS_FLAG, {
      description: `Maximum number of pi-flow subagents that may run concurrently (default: ${defaultMaxConcurrentSubagents})`,
      type: "string",
      default: String(defaultMaxConcurrentSubagents),
    });
    pi.registerFlag(SUBAGENT_TIMEOUT_MS_FLAG, {
      description: `Maximum wall-clock runtime for each pi-flow subagent in milliseconds; set 0 to disable (default: ${defaultSubagentTimeoutMs})`,
      type: "string",
      default: String(defaultSubagentTimeoutMs),
    });

    const rootState: DelegationState = {
      limiter: new ConcurrencyLimiter(defaultMaxConcurrentSubagents),
      maxConcurrentSubagents: defaultMaxConcurrentSubagents,
      subagentTimeoutMs: defaultSubagentTimeoutMs,
      progressEnabled: false,
      activeRuns: new Map(),
      sessionBindings: new Map(),
      sessionKeyLocks: new SessionKeyLocks(),
      frame: 0,
    };
    const syncMaxConcurrentSubagents = () => {
      const current = normalizeMaxConcurrentSubagents(
        pi.getFlag(MAX_CONCURRENT_SUBAGENTS_FLAG),
        defaultMaxConcurrentSubagents,
        `--${MAX_CONCURRENT_SUBAGENTS_FLAG}`,
      );
      if (current !== rootState.maxConcurrentSubagents) {
        rootState.limiter = new ConcurrencyLimiter(current);
        rootState.maxConcurrentSubagents = current;
      }
      rootState.subagentTimeoutMs = normalizeSubagentTimeoutMs(
        pi.getFlag(SUBAGENT_TIMEOUT_MS_FLAG),
        defaultSubagentTimeoutMs,
        `--${SUBAGENT_TIMEOUT_MS_FLAG}`,
      );
      return rootState;
    };
    const usageStatusState = createUsageStatusState();
    const toolOptions: CreateAgentToolOptions = {
      getThinkingLevel: () => pi.getThinkingLevel(),
      getSubagentTimeoutMs: () => syncMaxConcurrentSubagents().subagentTimeoutMs,
      updateStatus: (ctx, toolCallId, usage) => {
        if (!ctx.hasUI) {
          return;
        }
        updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
      },
    };

    pi.registerTool(createAgentTool(syncMaxConcurrentSubagents, toolOptions));
    if (workflowEnabled) {
      pi.registerTool(
        createWorkflowTool({
          getLimiter: () => syncMaxConcurrentSubagents().limiter,
          getThinkingLevel: () => pi.getThinkingLevel(),
          getSubagentTimeoutMs: () => syncMaxConcurrentSubagents().subagentTimeoutMs,
          updateStatus: (ctx, toolCallId, usage) => {
            if (!ctx.hasUI) {
              return;
            }
            updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
          },
        }),
      );
    }

    pi.on("session_start", (_event, ctx) => {
      syncMaxConcurrentSubagents();
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      usageStatusState.calls.clear();
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      const tools = pi.getAllTools();
      if (!tools.some((tool) => tool.name === "Agent")) {
        return;
      }
      // No per-turn counter reset: the shared ConcurrencyLimiter is acquired
      // immediately before a child spawn and released in the matching finally,
      // so the in-flight count stays accurate across turns without a reset.
      const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const sections = [event.systemPrompt, buildCoordinatorPrompt(profiles)];
      if (workflowEnabled && tools.some((tool) => tool.name === "workflow")) {
        const savedWorkflows = listSavedWorkflows({
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          projectTrusted: isProjectTrusted(ctx),
        });
        sections.push(buildWorkflowPrompt(profiles, savedWorkflows));
      }
      return { systemPrompt: sections.join("\n\n") };
    });
  };
}

export const createFlowExtension = createSubagentExtension;

export default createFlowExtension();
