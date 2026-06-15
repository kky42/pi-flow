import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
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
): SubagentProgressNode {
  return {
    id,
    description,
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
    latestCacheHitRate: extractLatestCacheHitRate(session.messages),
  };
}
