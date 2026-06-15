import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ModelRegistry,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  AGENT_PROMPT_GUIDELINES,
  AGENT_PROMPT_SNIPPET,
  buildCoordinatorPrompt,
} from "./prompts.ts";
import { getSubagentProfiles } from "./profiles.ts";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import { filterProfilesForModelRegistry, resolveProfileModel } from "./core/model.ts";
import { spawnSubagent } from "./core/spawn.ts";
import { textResult } from "./core/progress.ts";
import type {
  SubagentExtensionOptions,
  SubagentProfile,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentType,
  SubagentUsage,
} from "./types.ts";

const DEFAULT_MAX_CONCURRENCY = 12;

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
});

type AgentToolParams = Static<typeof agentToolParameters>;

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrency: number;
  progressEnabled: boolean;
}

interface SubagentUsageStatusState {
  calls: Map<string, SubagentUsage>;
  latestCacheHitRate?: number;
}

interface CreateAgentToolOptions {
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
}

const ACTIVITY_DISPLAY_PREVIEW_CHARS = 120;
const PROGRESS_STATUSES: SubagentProgressNode["status"][] = ["running", "completed", "rejected", "error"];

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

function normalizeLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeSubagentType(value: string | undefined): SubagentType {
  if (value === undefined || value.trim() === "") {
    return "general-purpose";
  }
  return value.trim();
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

function isSubagentProgressNode(value: unknown): value is SubagentProgressNode {
  if (!isRecord(value)) {
    return false;
  }
  const subagentType = value.subagentType;
  return (
    typeof value.id === "string" &&
    typeof value.description === "string" &&
    typeof subagentType === "string" &&
    isProgressStatus(value.status) &&
    Number.isFinite(value.startedAt) &&
    Array.isArray(value.activity) &&
    value.activity.every((line) => typeof line === "string") &&
    Number.isFinite(value.activityCount)
  );
}

function getDisplayLabel(subagentType: SubagentType | "unknown"): string {
  return subagentType;
}

function formatProgressTitle(node: SubagentProgressNode): string {
  const label = getDisplayLabel(node.subagentType);
  const description = node.description.trim();
  return description ? `Agent(${label}: ${description})` : `Agent(${label})`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTokens(count: number): string {
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

function formatUsage(usage: SubagentUsage): string {
  const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
  if (usage.cacheRead) {
    parts.push(`R${formatTokens(usage.cacheRead)}`);
  }
  if (usage.cacheWrite) {
    parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
    parts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
  }
  if (usage.cost) {
    parts.push(`$${usage.cost.toFixed(3)}`);
  }
  return parts.join(" ");
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
    latestCacheHitRate: state.latestCacheHitRate,
  };
  for (const usage of state.calls.values()) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost;
  }
  return totals;
}

function formatUsageStatus(totals: SubagentUsage, theme: Theme): string {
  return `${theme.fg("dim", "pi-subagents ")}${theme.fg("dim", formatUsage(totals))}`;
}

function publishUsageStatus(ctx: ExtensionContext, state: SubagentUsageStatusState): void {
  const totals = getUsageTotals(state);
  if (totals.input === 0 && totals.output === 0 && totals.cacheRead === 0 && totals.cacheWrite === 0 && totals.cost === 0) {
    ctx.ui.setStatus("pi-subagents", undefined);
    return;
  }
  ctx.ui.setStatus("pi-subagents", formatUsageStatus(totals, ctx.ui.theme));
}

function updateUsageStatus(
  state: SubagentUsageStatusState,
  ctx: ExtensionContext,
  toolCallId: string,
  usage: SubagentUsage,
): void {
  state.calls.set(toolCallId, usage);
  if (usage.latestCacheHitRate !== undefined) {
    state.latestCacheHitRate = usage.latestCacheHitRate;
  }
  publishUsageStatus(ctx, state);
}

function formatActivityLineForDisplay(line: string): string {
  if (line.length <= ACTIVITY_DISPLAY_PREVIEW_CHARS) {
    return line;
  }
  const hiddenChars = line.length - ACTIVITY_DISPLAY_PREVIEW_CHARS;
  return `${line.slice(0, ACTIVITY_DISPLAY_PREVIEW_CHARS).trimEnd()} ... (+${hiddenChars} chars)`;
}

function formatStatusReason(error: string | undefined): string {
  if (!error) {
    return "";
  }
  if (error === "Maximum subagent concurrency reached") {
    return ": max concurrency reached";
  }
  return `: ${error}`;
}

function renderProgressNode(node: SubagentProgressNode, theme: Theme): Container {
  const container = new Container();
  const status = node.status === "completed" ? "done" : node.status;
  const elapsed = formatDuration((node.endedAt ?? Date.now()) - node.startedAt);
  const usage = node.usage ? ` ${formatUsage(node.usage)}` : "";
  container.addChild(
    new Text(
      `${theme.bold(formatProgressTitle(node))} ${theme.fg("dim", `${status} ${elapsed}${usage}`)}`,
      0,
      0,
    ),
  );

  const skipped = node.activityCount - node.activity.length;
  if (skipped > 0) {
    container.addChild(new Text(`  ${theme.fg("muted", `... +${skipped} earlier events`)}`, 0, 0));
  }
  for (const line of node.activity) {
    container.addChild(new TruncatedText(`  ${theme.fg("muted", formatActivityLineForDisplay(line))}`, 0, 0));
  }

  if (node.error) {
    container.addChild(new Text(`  ${theme.fg("error", node.error)}`, 0, 0));
  }

  return container;
}

function createAgentTool(
  state: DelegationState,
  options: CreateAgentToolOptions,
): ToolDefinition<typeof agentToolParameters, SubagentToolDetails> {
  return defineTool({
    name: "Agent",
    label: "Agent",
    description: "Launch a fresh subagent. Available agents include built-ins and custom profiles from ~/.pi/agent/subagents/*.md. Prompts must be self-contained.",
    promptSnippet: AGENT_PROMPT_SNIPPET,
    promptGuidelines: AGENT_PROMPT_GUIDELINES,
    parameters: agentToolParameters,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const effectiveState: DelegationState = {
        ...state,
        progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
      };
      const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const subagentType = normalizeSubagentType(params.subagent_type);
      const profile = profiles.get(subagentType);
      if (!profile) {
        return textResult(
          `Unknown subagent_type "${params.subagent_type}". Available agents: ${formatProfileNames(profiles)}.`,
          {
            description: params.description,
            subagentType: "unknown",
            status: "rejected",
            error: "Unknown subagent_type",
          },
        );
      }

      const model = resolveProfileModel(profile, ctx);
      if (!model) {
        const error = profile.model ? `Profile model not found: ${profile.model}` : "No model is selected";
        return textResult(`Cannot launch subagent: ${error}.`, {
          description: params.description,
          subagentType,
          status: "rejected",
          error,
        });
      }

      const release = state.limiter.tryAcquire();
      if (!release) {
        return textResult(
          `Maximum subagent concurrency reached for this agent run. maxConcurrency: ${effectiveState.maxConcurrency}.`,
          {
            description: params.description,
            subagentType,
            status: "rejected",
            error: "Maximum subagent concurrency reached",
          },
        );
      }

      try {
        return await spawnSubagent({
          toolCallId,
          description: params.description,
          prompt: params.prompt,
          profile,
          model,
          thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
          ctx,
          signal,
          progressEnabled: effectiveState.progressEnabled,
          onProgress: effectiveState.progressEnabled ? onUpdate : undefined,
          onUsage: (usage) => options.updateStatus(ctx, toolCallId, usage),
          excludeTools: ["Agent"],
        });
      } finally {
        release();
      }
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const subagentType = normalizeSubagentType(args.subagent_type);
      const description = typeof args.description === "string" ? args.description.trim() : "";
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", subagentType)}${description ? ` ${theme.fg("dim", description)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as SubagentToolDetails;
      if (details.progress) {
        return renderProgressNode(details.progress, theme);
      }
      const usage = details.usage ? ` ${formatUsage(details.usage)}` : "";
      const reason = details.status === "rejected" || details.status === "error" ? formatStatusReason(details.error) : "";
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", details.subagentType)} ${theme.fg("dim", details.description)} ${theme.fg("dim", `${details.status}${reason}${usage}`)}`,
        0,
        0,
      );
    },
  });
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
  const maxConcurrency = normalizeLimit(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, "maxConcurrency");

  return function subagentExtension(pi: ExtensionAPI) {
    const rootState: DelegationState = {
      limiter: new ConcurrencyLimiter(maxConcurrency),
      maxConcurrency,
      progressEnabled: false,
    };
    const usageStatusState = createUsageStatusState();
    const toolOptions: CreateAgentToolOptions = {
      getThinkingLevel: () => pi.getThinkingLevel(),
      updateStatus: (ctx, toolCallId, usage) => {
        if (!ctx.hasUI) {
          return;
        }
        updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
      },
    };

    pi.registerTool(createAgentTool(rootState, toolOptions));

    pi.on("session_start", (_event, ctx) => {
      usageStatusState.calls.clear();
      usageStatusState.latestCacheHitRate = undefined;
      if (ctx.hasUI) {
        ctx.ui.setStatus("pi-subagents", undefined);
      }
    });

    pi.on("before_agent_start", (event) => {
      if (!pi.getAllTools().some((tool) => tool.name === "Agent")) {
        return;
      }
      // No per-turn counter reset: the shared ConcurrencyLimiter takes a slot
      // synchronously in execute() before the first await and releases it in the
      // finally. Acquisition is synchronous and release always runs, so the
      // in-flight count stays accurate across turns without a reset.
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildCoordinatorPrompt(filterProfilesForModelRegistry(
          getSubagentProfiles(getAgentDir()),
          (pi as unknown as { modelRegistry?: ModelRegistry }).modelRegistry,
        ))}`,
      };
    });
  };
}

export default createSubagentExtension();
