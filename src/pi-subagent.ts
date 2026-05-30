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
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  AGENT_PROMPT_GUIDELINES,
  AGENT_PROMPT_SNIPPET,
  buildCoordinatorPrompt,
  getPresetAppendPrompt,
} from "./prompts.ts";
import type { SubagentExtensionOptions, SubagentProgressNode, SubagentToolDetails, SubagentType } from "./types.ts";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_WIDTH = 4;
const ALLOWED_SUBAGENTS: SubagentType[] = ["general-purpose", "explorer"];

const agentToolParameters = Type.Object({
  description: Type.String({
    description: "A short 3-5 word description of the task, used for UI display and routing context.",
  }),
  prompt: Type.String({
    description: "The self-contained task briefing to send to the subagent.",
  }),
  subagent_type: Type.Optional(
    Type.String({
      description: `The preset subagent to use. Allowed values: ${ALLOWED_SUBAGENTS.join(", ")}. Defaults to general-purpose.`,
    }),
  ),
});

type AgentToolParams = Static<typeof agentToolParameters>;

interface DelegationState {
  depth: number;
  maxDepth: number;
  maxWidth: number;
  childCount: number;
  progressEnabled: boolean;
}

interface CreateAgentToolOptions {
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

type AgentToolResult = ReturnType<typeof textResult>;

const MAX_ACTIVITY_LINES = 3;
const ACTIVITY_DISPLAY_PREVIEW_CHARS = 120;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_STATUSES: SubagentProgressNode["status"][] = ["running", "completed", "rejected", "error"];

function getCliMode(argv = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") {
      return argv[i + 1];
    }
    if (arg.startsWith("--mode=")) {
      return arg.slice("--mode=".length);
    }
  }
  return undefined;
}

function shouldEnableProgress(ctx: ExtensionContext): boolean {
  const mode = getCliMode();
  return ctx.hasUI && mode !== "json" && mode !== "rpc";
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

function normalizeSubagentType(value: string | undefined): SubagentType | undefined {
  if (value === undefined || value.trim() === "") {
    return "general-purpose";
  }
  return ALLOWED_SUBAGENTS.includes(value as SubagentType) ? (value as SubagentType) : undefined;
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
    (subagentType === "unknown" || ALLOWED_SUBAGENTS.includes(subagentType as SubagentType)) &&
    Number.isFinite(value.depth) &&
    isProgressStatus(value.status) &&
    Number.isFinite(value.startedAt) &&
    Array.isArray(value.activity) &&
    value.activity.every((line) => typeof line === "string") &&
    Number.isFinite(value.activityCount) &&
    Array.isArray(value.children)
  );
}

function getProgressFromToolResult(result: unknown): SubagentProgressNode | undefined {
  if (!isRecord(result) || !isRecord(result.details) || !("subagentType" in result.details)) {
    return undefined;
  }
  return isSubagentProgressNode(result.details.progress) ? result.details.progress : undefined;
}

function createProgressNode(
  id: string,
  params: AgentToolParams,
  subagentType: SubagentType,
  depth: number,
  status: SubagentProgressNode["status"] = "running",
): SubagentProgressNode {
  return {
    id,
    description: params.description,
    subagentType,
    depth,
    status,
    startedAt: Date.now(),
    activity: [],
    activityCount: 0,
    children: [],
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
    const childProgress = event.toolName === "Agent" ? getProgressFromToolResult(event.partialResult) : undefined;
    if (childProgress) {
      progress.children = mergeChildProgress(progress.children, childProgress);
    }
    return;
  }

  if (event.type === "tool_execution_end") {
    const childProgress = event.toolName === "Agent" ? getProgressFromToolResult(event.result) : undefined;
    if (childProgress) {
      progress.children = mergeChildProgress(progress.children, childProgress);
    }
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

function mergeChildProgress(
  children: SubagentProgressNode[],
  child: SubagentProgressNode,
): SubagentProgressNode[] {
  const index = children.findIndex((candidate) => candidate.id === child.id);
  if (index === -1) {
    return [...children, child];
  }
  const next = children.slice();
  next[index] = child;
  return next;
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

function formatActivityLineForDisplay(line: string): string {
  if (line.length <= ACTIVITY_DISPLAY_PREVIEW_CHARS) {
    return line;
  }
  const hiddenChars = line.length - ACTIVITY_DISPLAY_PREVIEW_CHARS;
  return `${line.slice(0, ACTIVITY_DISPLAY_PREVIEW_CHARS).trimEnd()} ... (+${hiddenChars} chars)`;
}

function renderProgressNode(
  node: SubagentProgressNode,
  theme: Theme,
  depth = 0,
): Container {
  const container = new Container();
  const indent = "  ".repeat(depth);
  const status = node.status === "completed" ? "done" : node.status;
  const elapsed = formatDuration((node.endedAt ?? Date.now()) - node.startedAt);
  container.addChild(
    new Text(
      `${indent}${theme.bold(formatProgressTitle(node))} ${theme.fg("dim", `${status} ${elapsed}`)}`,
      0,
      0,
    ),
  );

  const skipped = node.activityCount - node.activity.length;
  if (skipped > 0) {
    container.addChild(new Text(`${indent}  ${theme.fg("muted", `... +${skipped} earlier events`)}`, 0, 0));
  }
  for (const line of node.activity) {
    container.addChild(new TruncatedText(`${indent}  ${theme.fg("muted", formatActivityLineForDisplay(line))}`, 0, 0));
  }

  for (const child of node.children) {
    container.addChild(renderProgressNode(child, theme, depth + 1));
  }
  if (node.error) {
    container.addChild(new Text(`${indent}  ${theme.fg("error", node.error)}`, 0, 0));
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

async function runSubagent(
  toolCallId: string,
  params: AgentToolParams,
  subagentType: SubagentType,
  state: DelegationState,
  options: CreateAgentToolOptions,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onProgress: ((result: AgentToolResult) => void) | undefined,
): Promise<ReturnType<typeof textResult>> {
  const progressDepth = state.depth + 1;
  const progress =
    state.progressEnabled ? createProgressNode(toolCallId, params, subagentType, progressDepth) : undefined;

  if (!ctx.model) {
    return textResult("Cannot launch subagent: no model is selected.", {
      description: params.description,
      subagentType,
      depth: progressDepth,
      status: "rejected",
      error: "No model is selected",
      ...(progress ? { progress: { ...progress, status: "rejected", error: "No model is selected" } } : {}),
    });
  }

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    getPresetAppendPrompt(subagentType),
    buildCoordinatorPrompt(state.maxDepth, state.maxWidth),
  ].filter((prompt): prompt is string => Boolean(prompt));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
  });
  await resourceLoader.reload();

  const childState: DelegationState = {
    depth: progressDepth,
    maxDepth: state.maxDepth,
    maxWidth: state.maxWidth,
    childCount: 0,
    progressEnabled: state.progressEnabled,
  };

  const nestedAgentTool = createAgentTool(childState, options);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: ctx.model,
    thinkingLevel: options.getThinkingLevel(),
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    customTools: [nestedAgentTool as ToolDefinition],
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
      depth: progressDepth,
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

  const unsubscribe = progress
    ? session.subscribe((event) => {
        updateProgressFromEvent(progress, event);
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
    await session.prompt(params.prompt, { source: "extension" });
    const result = extractFinalAssistantText(session.messages) || "(no final text output)";
    if (progress) {
      progress.status = "completed";
      progress.result = result;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      depth: childState.depth,
      status: "completed",
      result,
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (progress) {
      progress.status = "error";
      progress.error = message;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) failed: ${message}`, {
      description: params.description,
      subagentType,
      depth: childState.depth,
      status: "error",
      error: message,
      ...(progress ? { progress } : {}),
    });
  } finally {
    if (pendingProgressTimer) {
      clearTimeout(pendingProgressTimer);
    }
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
    description: `Launch a fresh subagent. Available agents: ${ALLOWED_SUBAGENTS.join(", ")}. Prompts must be self-contained.`,
    promptSnippet: AGENT_PROMPT_SNIPPET,
    promptGuidelines: AGENT_PROMPT_GUIDELINES,
    parameters: agentToolParameters,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const effectiveState: DelegationState = {
        ...state,
        progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
      };
      const subagentType = normalizeSubagentType(params.subagent_type);
      if (!subagentType) {
        return textResult(
          `Unknown subagent_type "${params.subagent_type}". Allowed values: ${ALLOWED_SUBAGENTS.join(", ")}.`,
          {
            description: params.description,
            subagentType: "unknown",
            depth: effectiveState.depth + 1,
            status: "rejected",
            error: "Unknown subagent_type",
          },
        );
      }

      if (effectiveState.depth >= effectiveState.maxDepth) {
        return textResult(
          `Maximum subagent depth reached. Current depth: ${effectiveState.depth}; maxDepth: ${effectiveState.maxDepth}.`,
          {
            description: params.description,
            subagentType,
            depth: effectiveState.depth + 1,
            status: "rejected",
            error: "Maximum subagent depth reached",
          },
        );
      }

      if (state.childCount >= effectiveState.maxWidth) {
        return textResult(
          `Maximum subagent width reached for this agent run. maxWidth: ${effectiveState.maxWidth}.`,
          {
            description: params.description,
            subagentType,
            depth: effectiveState.depth + 1,
            status: "rejected",
            error: "Maximum subagent width reached",
          },
        );
      }

      state.childCount++;
      return runSubagent(
        toolCallId,
        params,
        subagentType,
        effectiveState,
        options,
        signal,
        ctx,
        effectiveState.progressEnabled ? onUpdate : undefined,
      );
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const subagentType = normalizeSubagentType(args.subagent_type) ?? "unknown";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", subagentType)}${description ? ` ${theme.fg("dim", description)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      if (details.progress) {
        return renderProgressNode(details.progress, theme);
      }
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", details.subagentType)} ${theme.fg("dim", details.description)} ${theme.fg("dim", details.status)}`,
        0,
        0,
      );
    },
  });
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
  const maxDepth = normalizeLimit(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth");
  const maxWidth = normalizeLimit(options.maxWidth, DEFAULT_MAX_WIDTH, "maxWidth");

  return function subagentExtension(pi: ExtensionAPI) {
    const rootState: DelegationState = {
      depth: 0,
      maxDepth,
      maxWidth,
      childCount: 0,
      progressEnabled: false,
    };
    const toolOptions: CreateAgentToolOptions = {
      getThinkingLevel: () => pi.getThinkingLevel(),
    };

    pi.registerTool(createAgentTool(rootState, toolOptions));

    pi.on("before_agent_start", (event) => {
      rootState.childCount = 0;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildCoordinatorPrompt(maxDepth, maxWidth)}`,
      };
    });
  };
}

export default createSubagentExtension();
