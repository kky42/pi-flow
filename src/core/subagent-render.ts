import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { getBackendAgentLabel } from "./display.ts";
import { SPINNER_FRAMES } from "./spinner.ts";
import type { SubagentBackend, SubagentRunStatus, SubagentUsage } from "../types.ts";
export { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./spinner.ts";

const ACTIVITY_DISPLAY_PREVIEW_CHARS = 120;
export const RICH_SUBAGENT_ACTIVE_LIMIT = 4;

export interface RenderableSubagentNode {
  description?: string;
  label?: string;
  subagentType?: string;
  backend?: SubagentBackend;
  status: SubagentRunStatus;
  startedAt?: number;
  endedAt?: number;
  activity?: string[];
  activityCount?: number;
  result?: string;
  error?: string;
  usage?: SubagentUsage;
}

export function isActiveSubagentStatus(status: SubagentRunStatus): boolean {
  return status === "queued" || status === "running";
}

export function isCompletedSubagentStatus(status: SubagentRunStatus): boolean {
  return status === "done";
}

export function formatDuration(ms: number): string {
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

export function formatTokens(count: number): string {
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

export function formatUsage(usage: SubagentUsage): string {
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
    parts.push(`$${usage.cost.toFixed(3)}${usage.costKnown === false ? "+?" : ""}`);
  }
  return parts.join(" ");
}

export function subagentMarker(status: SubagentRunStatus, theme: Theme, frame: number): string {
  if (status === "running") return theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
  if (status === "queued") return theme.fg("muted", "◌");
  if (isCompletedSubagentStatus(status)) return theme.fg("success", "✓");
  if (status === "aborted") return theme.fg("warning", "⊘");
  return theme.fg("error", "✗");
}

function formatActivityLineForDisplay(line: string): string {
  if (line.length <= ACTIVITY_DISPLAY_PREVIEW_CHARS) {
    return line;
  }
  const hiddenChars = line.length - ACTIVITY_DISPLAY_PREVIEW_CHARS;
  return `${line.slice(0, ACTIVITY_DISPLAY_PREVIEW_CHARS).trimEnd()} ... (+${hiddenChars} chars)`;
}

function nodeType(node: RenderableSubagentNode): string {
  return node.subagentType || "agent";
}

function nodeLabel(node: RenderableSubagentNode): string {
  return (node.label ?? node.description ?? "").trim();
}

function compactTitle(node: RenderableSubagentNode): string {
  const label = nodeLabel(node);
  return `${getBackendAgentLabel(node.backend)}(${nodeType(node)}${label ? `, ${label}` : ""})`;
}

function richTitle(node: RenderableSubagentNode): string {
  const label = nodeLabel(node);
  return `${getBackendAgentLabel(node.backend)}(${nodeType(node)}${label ? `: ${label}` : ""})`;
}

function formatRuntimeAndUsage(node: RenderableSubagentNode, now: number): string {
  const parts: string[] = [];
  const startedAt = node.startedAt;
  if (typeof startedAt === "number") {
    const duration = formatDuration((node.endedAt ?? now) - startedAt);
    if (node.status === "queued") {
      parts.push(`queued ${duration}`);
    } else {
      parts.push(duration);
    }
  } else if (node.status === "queued") {
    parts.push("queued");
  }
  if (node.usage) {
    const usage = formatUsage(node.usage);
    if (usage) {
      parts.push(usage);
    }
  }
  return parts.join(" ");
}

export function shouldRenderRichSubagent(node: RenderableSubagentNode, runningCount: number): boolean {
  return node.status === "running" && runningCount <= RICH_SUBAGENT_ACTIVE_LIMIT;
}

export function renderCompactSubagentNode(
  node: RenderableSubagentNode,
  theme: Theme,
  frame: number,
  indent = "",
  now = Date.now(),
): Text {
  const status = node.status;
  const bodyColor = status === "error" || status === "aborted" ? "error" : "muted";
  const runtime = formatRuntimeAndUsage(node, now);
  const detail = node.error && (status === "error" || status === "aborted")
    ? `${status}: ${node.error}`
    : "";
  const meta = [runtime, detail].filter(Boolean).join(" ");
  return new Text(
    `${indent}${subagentMarker(status, theme, frame)} ${theme.fg(bodyColor, compactTitle(node))}${meta ? ` ${theme.fg("dim", meta)}` : ""}`,
    0,
    0,
  );
}

export function renderRichSubagentNode(
  node: RenderableSubagentNode,
  theme: Theme,
  frame: number,
  indent = "",
  now = Date.now(),
): Container {
  const container = new Container();
  const status = node.status;
  const meta = formatRuntimeAndUsage({ ...node, status }, now);
  container.addChild(
    new Text(
      `${indent}${subagentMarker(status, theme, frame)} ${theme.bold(richTitle(node))}${meta ? ` ${theme.fg("dim", meta)}` : ""}`,
      0,
      0,
    ),
  );

  const activity = node.activity ?? [];
  const activityCount = node.activityCount ?? activity.length;
  const skipped = activityCount - activity.length;
  if (skipped > 0) {
    container.addChild(new Text(`${indent}  ${theme.fg("muted", `... +${skipped} earlier events`)}`, 0, 0));
  }
  for (const line of activity) {
    container.addChild(new TruncatedText(`${indent}  ${theme.fg("muted", formatActivityLineForDisplay(line))}`, 0, 0));
  }

  if (node.error) {
    container.addChild(new Text(`${indent}  ${theme.fg("error", node.error)}`, 0, 0));
  }

  return container;
}

export function renderSubagentNode(
  node: RenderableSubagentNode,
  theme: Theme,
  frame: number,
  runningCount: number,
  indent = "",
  now = Date.now(),
): Text | Container {
  return shouldRenderRichSubagent(node, runningCount)
    ? renderRichSubagentNode(node, theme, frame, indent, now)
    : renderCompactSubagentNode(node, theme, frame, indent, now);
}
