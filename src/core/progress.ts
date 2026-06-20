import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  SubagentBackend,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentType,
  SubagentUsage,
} from "../types.ts";

export const MAX_ACTIVITY_LINES = 2;
export const PROGRESS_UPDATE_INTERVAL_MS = 250;
export const PROGRESS_HEARTBEAT_INTERVAL_MS = 1000;

export function textResult(text: string, details: SubagentToolDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export type AgentToolResult = ReturnType<typeof textResult>;

export function createProgressNode(
  id: string,
  description: string,
  subagentType: SubagentType,
  status: SubagentProgressNode["status"] = "running",
  backend?: SubagentBackend,
): SubagentProgressNode {
  return {
    id,
    description,
    subagentType,
    ...(backend ? { backend } : {}),
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

export function updateProgressFromEvent(progress: SubagentProgressNode, event: AgentSessionEvent): void {
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

export interface ProgressEmitterOptions {
  toolCallId: string;
  description: string;
  subagentType: SubagentType;
  backend?: SubagentBackend;
  enabled: boolean;
  onProgress: ((result: AgentToolResult) => void) | undefined;
}

export interface ProgressEmitter {
  /** The live progress node, or undefined when progress is disabled. */
  readonly progress: SubagentProgressNode | undefined;
  /** Append an activity line (no-op when disabled). */
  addActivity(line: string): void;
  /** Replace the latest activity line (no-op when disabled). */
  replaceLatestActivity(line: string): void;
  /** Emit a progress snapshot immediately, resetting the throttle window. */
  emit(): void;
  /** Emit a progress snapshot, throttled to PROGRESS_UPDATE_INTERVAL_MS. */
  emitSoon(): void;
  /** Start the periodic heartbeat that keeps the live row fresh. */
  startHeartbeat(): void;
  /** Clear the pending throttle timer and stop the heartbeat. */
  stop(): void;
}

/**
 * Owns the progress node plus the throttled-emit + heartbeat machinery shared by
 * every subagent backend (pi, codex, claude). Extracted so the emit cadence and
 * the queued→running / abort timing live in ONE place instead of three
 * hand-synchronized copies that silently drift.
 */
export function createProgressEmitter(options: ProgressEmitterOptions): ProgressEmitter {
  const { toolCallId, description, subagentType, backend, enabled, onProgress } = options;
  const progress = enabled
    ? createProgressNode(toolCallId, description, subagentType, "running", backend)
    : undefined;
  const live = Boolean(progress && onProgress);

  let lastProgressEmit = 0;
  let pendingProgressTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const emit = (): void => {
    if (!progress || !onProgress) {
      return;
    }
    if (pendingProgressTimer) {
      clearTimeout(pendingProgressTimer);
      pendingProgressTimer = undefined;
    }
    lastProgressEmit = Date.now();
    onProgress(
      textResult(`Subagent "${description}" (${subagentType}) is running.`, {
        description,
        subagentType,
        ...(backend ? { backend } : {}),
        status: progress.status,
        result: progress.result,
        error: progress.error,
        progress,
      }),
    );
  };

  const emitSoon = (): void => {
    if (!progress || !onProgress) {
      return;
    }
    const elapsed = Date.now() - lastProgressEmit;
    if (elapsed >= PROGRESS_UPDATE_INTERVAL_MS) {
      emit();
      return;
    }
    if (!pendingProgressTimer) {
      pendingProgressTimer = setTimeout(() => {
        pendingProgressTimer = undefined;
        emit();
      }, PROGRESS_UPDATE_INTERVAL_MS - elapsed);
    }
  };

  const startHeartbeat = (): void => {
    if (!live || heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      emitSoon();
    }, PROGRESS_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  };

  const stop = (): void => {
    if (pendingProgressTimer) {
      clearTimeout(pendingProgressTimer);
      pendingProgressTimer = undefined;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  return {
    progress,
    addActivity: (line) => {
      if (progress) {
        addActivity(progress, line);
      }
    },
    replaceLatestActivity: (line) => {
      if (progress) {
        replaceLatestActivity(progress, line);
      }
    },
    emit,
    emitSoon,
    startHeartbeat,
    stop,
  };
}

export function extractFinalAssistantText(messages: readonly unknown[]): string {
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

/**
 * Detect a terminal model failure on the final assistant turn.
 *
 * pi-ai's stream contract does NOT throw or reject for request/model/runtime
 * failures (rate limits, quota exhaustion, provider 4xx/5xx, etc.). It encodes
 * them as a final AssistantMessage with stopReason "error" (or "aborted") and an
 * errorMessage, so `session.prompt()` resolves normally even when the turn never
 * produced a real completion. A caller that treats "prompt() resolved" as
 * success would mark such a run "done" with empty output and zero tokens.
 *
 * Returns the failure of the LAST assistant turn (the terminal one), or
 * undefined when that turn ended normally ("stop"/"length"/"toolUse").
 */
export function getFinalAssistantFailure(
  messages: readonly unknown[],
): { stopReason: "error" | "aborted"; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant") {
      continue;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        stopReason: message.stopReason,
        ...(typeof message.errorMessage === "string" && message.errorMessage
          ? { errorMessage: message.errorMessage }
          : {}),
      };
    }
    // The terminal assistant turn ended normally; not a failure.
    return undefined;
  }
  return undefined;
}

export function extractLatestCacheHitRate(messages: readonly unknown[]): number | undefined {
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

export function getSubagentUsage(session: {
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
    costKnown: true,
    latestCacheHitRate: extractLatestCacheHitRate(session.messages),
  };
}
