import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
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
import type {
  SubagentExtensionOptions,
  SubagentProfile,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentType,
  SubagentUsage,
} from "./types.ts";

const DEFAULT_MAX_WIDTH = 12;

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
  maxWidth: number;
  childCount: number;
  progressEnabled: boolean;
}

interface CreateAgentToolOptions {
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

type AgentToolResult = ReturnType<typeof textResult>;

const MAX_ACTIVITY_LINES = 2;
const ACTIVITY_DISPLAY_PREVIEW_CHARS = 120;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_HEARTBEAT_INTERVAL_MS = 1000;
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

function findProfileModel(profile: SubagentProfile, modelRegistry: ModelRegistry): ExtensionContext["model"] {
  if (!profile.model) {
    return undefined;
  }
  const separator = profile.model.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  return modelRegistry.find(profile.model.slice(0, separator), profile.model.slice(separator + 1));
}

function resolveProfileModel(profile: SubagentProfile, ctx: ExtensionContext): ExtensionContext["model"] {
  return profile.model ? findProfileModel(profile, ctx.modelRegistry) : ctx.model;
}

function filterProfilesForModelRegistry(
  profiles: Map<string, SubagentProfile>,
  modelRegistry: ModelRegistry | undefined,
): Map<string, SubagentProfile> {
  if (!modelRegistry) {
    return profiles;
  }
  return new Map(
    [...profiles].filter(([, profile]) => !profile.model || Boolean(findProfileModel(profile, modelRegistry))),
  );
}

function textResult(text: string, details: SubagentToolDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
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

function createProgressNode(
  id: string,
  params: AgentToolParams,
  subagentType: SubagentType,
  status: SubagentProgressNode["status"] = "running",
): SubagentProgressNode {
  return {
    id,
    description: params.description,
    subagentType,
    status,
    startedAt: Date.now(),
    activity: [],
    activityCount: 0,
  };
}

function addActivity(progress: SubagentProgressNode, line: string): void {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return;
  }
  progress.activityCount++;
  progress.activity.push(normalized);
  if (progress.activity.length > MAX_ACTIVITY_LINES) {
    progress.activity.splice(0, progress.activity.length - MAX_ACTIVITY_LINES);
  }
}

function replaceLatestActivity(progress: SubagentProgressNode, line: string): void {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return;
  }
  if (progress.activity.length === 0) {
    addActivity(progress, normalized);
    return;
  }
  progress.activity[progress.activity.length - 1] = normalized;
}

function getFirstTextLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? text;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const block = part as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("\n")
    .trim();
}

function getToolArgPreview(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const record = args as Record<string, unknown>;
  const value =
    typeof record.description === "string" ? record.description
    : typeof record.path === "string" ? record.path
    : typeof record.command === "string" ? record.command
    : typeof record.pattern === "string" ? record.pattern
    : typeof record.query === "string" ? record.query
    : typeof record.url === "string" ? record.url
    : "";
  return value.replace(/\s+/g, " ").trim();
}

function updateProgressFromEvent(progress: SubagentProgressNode, event: AgentSessionEvent): void {
  if (event.type === "tool_execution_start") {
    if (event.toolName === "Agent") {
      return;
    }
    const preview = getToolArgPreview(event.args);
    addActivity(progress, `${event.toolName}${preview ? ` ${preview}` : ""}`);
    return;
  }

  if (event.type === "message_start" && event.message.role === "assistant") {
    addActivity(progress, "Thinking...");
    return;
  }

  if (event.type === "tool_execution_update") {
    return;
  }

  if (event.type === "tool_execution_end") {
    return;
  }

  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    const content =
      "partial" in assistantEvent ? assistantEvent.partial.content
      : "message" in assistantEvent ? assistantEvent.message.content
      : "error" in assistantEvent ? assistantEvent.error.content
      : undefined;
    const text = extractTextContent(content);
    if (text) {
      replaceLatestActivity(progress, getFirstTextLine(text));
    }
    return;
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    const text = extractTextContent(event.message.content);
    if (text) {
      replaceLatestActivity(progress, getFirstTextLine(text));
    }
  }
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
  if (error === "Maximum subagent width reached") {
    return ": max width reached";
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

function extractFinalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const textParts = message.content
      .map((part) => {
        const block = part as { type?: string; text?: unknown };
        return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
  }
  return "";
}

function extractLatestCacheHitRate(messages: readonly unknown[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
    };
    if (message.role !== "assistant" || !message.usage) {
      continue;
    }
    const input = message.usage.input ?? 0;
    const cacheRead = message.usage.cacheRead ?? 0;
    const cacheWrite = message.usage.cacheWrite ?? 0;
    const promptTokens = input + cacheRead + cacheWrite;
    return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
  }
  return undefined;
}

function getSubagentUsage(session: {
  getSessionStats: () => {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    cost: number;
  };
  messages: readonly unknown[];
}): SubagentUsage {
  const stats = session.getSessionStats();
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
    latestCacheHitRate: extractLatestCacheHitRate(session.messages),
  };
}

async function runSubagent(
  toolCallId: string,
  params: AgentToolParams,
  profile: SubagentProfile,
  model: NonNullable<ExtensionContext["model"]>,
  state: DelegationState,
  options: CreateAgentToolOptions,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onProgress: ((result: AgentToolResult) => void) | undefined,
): Promise<ReturnType<typeof textResult>> {
  const subagentType = profile.name;
  const progress =
    state.progressEnabled ? createProgressNode(toolCallId, params, subagentType) : undefined;

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    profile.systemPrompt,
  ].filter((prompt): prompt is string => Boolean(prompt));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) => !extension.tools.has("Agent")),
    }),
    appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    excludeTools: ["Agent"],
    ...(profile.tools !== undefined ? { tools: profile.tools } : {}),
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
    onProgress(textResult(`Subagent "${params.description}" (${subagentType}) is running.`, {
      description: params.description,
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

  const unsubscribe = progress
    ? session.subscribe((event) => {
        updateProgressFromEvent(progress, event);
        if (event.type === "message_end" && event.message.role === "assistant") {
          progress.usage = getSubagentUsage(session);
        }
        emitProgressSoon();
      })
    : undefined;

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
    await session.prompt(params.prompt, { source: "extension" });
    const result = extractFinalAssistantText(session.messages) || "(no final text output)";
    const usage = getSubagentUsage(session);
    if (progress) {
      progress.status = "completed";
      progress.result = result;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      status: "completed",
      result,
      usage,
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const usage = getSubagentUsage(session);
    if (progress) {
      progress.status = "error";
      progress.error = message;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) failed: ${message}`, {
      description: params.description,
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

      if (state.childCount >= effectiveState.maxWidth) {
        return textResult(
          `Maximum subagent width reached for this agent run. maxWidth: ${effectiveState.maxWidth}.`,
          {
            description: params.description,
            subagentType,
            status: "rejected",
            error: "Maximum subagent width reached",
          },
        );
      }

      state.childCount++;
      try {
        return await runSubagent(
          toolCallId,
          params,
          profile,
          model,
          effectiveState,
          options,
          signal,
          ctx,
          effectiveState.progressEnabled ? onUpdate : undefined,
        );
      } finally {
        state.childCount = Math.max(0, state.childCount - 1);
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
  const maxWidth = normalizeLimit(options.maxWidth, DEFAULT_MAX_WIDTH, "maxWidth");

  return function subagentExtension(pi: ExtensionAPI) {
    const rootState: DelegationState = {
      maxWidth,
      childCount: 0,
      progressEnabled: false,
    };
    const toolOptions: CreateAgentToolOptions = {
      getThinkingLevel: () => pi.getThinkingLevel(),
    };

    pi.registerTool(createAgentTool(rootState, toolOptions));

    pi.on("before_agent_start", (event) => {
      if (!pi.getAllTools().some((tool) => tool.name === "Agent")) {
        return;
      }
      rootState.childCount = 0;
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
