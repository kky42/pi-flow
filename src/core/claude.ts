import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createProgressEmitter,
  textResult,
  type AgentToolResult,
} from "./progress.ts";
import {
  createBoundedBuffer,
  MAX_STDERR_CHARS,
  MAX_STDOUT_LINE_CHARS,
} from "./stream.ts";
import type { SubagentProfile, SubagentUsage, ThinkingLevel } from "../types.ts";

const CLAUDE_COMMAND = "claude";
const FORCE_KILL_DELAY_MS = 3000;

export interface ClaudeTokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function buildClaudeArgs({
  profile,
  thinkingLevel,
  outputSchema,
}: {
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  outputSchema?: unknown;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
  ];
  if (profile.systemPrompt) {
    args.push("--append-system-prompt", profile.systemPrompt);
  }
  if (profile.model) {
    args.push("--model", profile.model);
  }
  if (thinkingLevel) {
    args.push("--effort", thinkingLevel);
  }
  if (outputSchema !== undefined && outputSchema !== null) {
    args.push("--json-schema", JSON.stringify(outputSchema));
  }
  return args;
}

export function parseClaudeJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function parseUsageRecord(value: unknown): ClaudeTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const cacheReadInputTokens = asFiniteNumber(usage.cache_read_input_tokens ?? 0);
  const cacheCreationInputTokens = asFiniteNumber(usage.cache_creation_input_tokens ?? 0);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  if (
    inputTokens === undefined ||
    cacheReadInputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    outputTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens };
}

function parseModelUsage(value: unknown): ClaudeTokenUsage | undefined {
  const modelUsage = asRecord(value);
  if (!modelUsage) {
    return undefined;
  }
  const totals: ClaudeTokenUsage = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
  let found = false;
  for (const item of Object.values(modelUsage)) {
    const usage = asRecord(item);
    if (!usage) {
      continue;
    }
    const inputTokens = asFiniteNumber(usage.inputTokens);
    const cacheReadInputTokens = asFiniteNumber(usage.cacheReadInputTokens ?? 0);
    const cacheCreationInputTokens = asFiniteNumber(usage.cacheCreationInputTokens ?? 0);
    const outputTokens = asFiniteNumber(usage.outputTokens);
    if (
      inputTokens === undefined ||
      cacheReadInputTokens === undefined ||
      cacheCreationInputTokens === undefined ||
      outputTokens === undefined
    ) {
      continue;
    }
    found = true;
    totals.inputTokens += inputTokens;
    totals.cacheReadInputTokens += cacheReadInputTokens;
    totals.cacheCreationInputTokens += cacheCreationInputTokens;
    totals.outputTokens += outputTokens;
  }
  return found ? totals : undefined;
}

function sumModelUsageCost(value: unknown): number | undefined {
  const modelUsage = asRecord(value);
  if (!modelUsage) {
    return undefined;
  }
  let total = 0;
  let found = false;
  for (const item of Object.values(modelUsage)) {
    const cost = asFiniteNumber(asRecord(item)?.costUSD);
    if (cost !== undefined) {
      found = true;
      total += cost;
    }
  }
  return found ? total : undefined;
}

export function extractClaudeUsage(event: Record<string, unknown>): ClaudeTokenUsage | undefined {
  if (event.type === "result") {
    return parseModelUsage(event.modelUsage) ?? parseUsageRecord(event.usage);
  }
  if (event.type !== "assistant") {
    return undefined;
  }
  const message = asRecord(event.message);
  return message ? parseUsageRecord(message.usage) : undefined;
}

export function extractClaudeCostUsd(event: Record<string, unknown>): number | undefined {
  if (event.type !== "result") {
    return undefined;
  }
  return asFiniteNumber(event.total_cost_usd) ?? sumModelUsageCost(event.modelUsage);
}

export function claudeUsageToSubagentUsage(usage: ClaudeTokenUsage, costUsd: number | undefined): SubagentUsage {
  const input = Math.max(0, usage.inputTokens);
  const cacheRead = Math.max(0, usage.cacheReadInputTokens);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens);
  const output = Math.max(0, usage.outputTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: costUsd ?? 0,
    costKnown: costUsd !== undefined,
    costEstimated: false,
    latestCacheHitRate: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined,
  };
}

function textFromClaudeContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("");
  return text ? text : undefined;
}

function structuredTextFromClaudeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function extractClaudeFinalText(event: Record<string, unknown>): string | undefined {
  if (event.type === "result") {
    return (
      structuredTextFromClaudeValue(event.structured_output) ??
      (typeof event.result === "string" ? event.result : undefined)
    );
  }
  if (event.type !== "assistant") {
    return undefined;
  }
  const message = asRecord(event.message);
  return message ? textFromClaudeContent(message.content) : undefined;
}

export function extractClaudeError(event: Record<string, unknown>): string | undefined {
  if (event.type === "result" && event.is_error === true) {
    const errors = Array.isArray(event.errors) ? event.errors : [];
    const first = errors.find((candidate) => typeof candidate === "string");
    const result = typeof event.result === "string" && event.result.trim() ? event.result.trim() : undefined;
    const apiStatus = event.api_error_status !== undefined && event.api_error_status !== null
      ? `API error ${String(event.api_error_status)}`
      : undefined;
    return `Claude failed: ${first ?? result ?? apiStatus ?? (typeof event.subtype === "string" ? event.subtype : "turn failed")}`;
  }
  if (event.type === "error") {
    return `Claude error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
  }
  return undefined;
}

function getPreviewFromRecord(record: Record<string, unknown>): string {
  const candidates = [
    record.command,
    record.cmd,
    record.file_path,
    record.path,
    record.pattern,
    record.query,
    record.prompt,
    record.description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.replace(/\s+/g, " ").trim();
    }
  }
  const input = asRecord(record.input) ?? asRecord(record.arguments) ?? asRecord(record.args);
  return input ? getPreviewFromRecord(input) : "";
}

export function claudeActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "system" && event.subtype === "init") {
    return "claude session started";
  }
  if (event.type === "result") {
    return "claude turn completed";
  }
  if (event.type === "assistant") {
    const message = asRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const block = asRecord(part);
        if (block?.type === "tool_use") {
          const toolName = typeof block.name === "string" && block.name ? block.name : "tool_use";
          const preview = getPreviewFromRecord(block);
          return `${toolName}${preview ? ` ${preview}` : ""}`;
        }
      }
    }
  }
  const error = extractClaudeError(event);
  return error ? error : undefined;
}

function emptyTokenUsage(): ClaudeTokenUsage {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below. This can happen if the process
      // exited between hasChildExited() and the process-group signal.
    }
  }
  child.kill(signal);
}

function abortChild(child: ChildProcess): void {
  if (hasChildExited(child)) {
    return;
  }
  signalChildTree(child, "SIGTERM");
  setTimeout(() => {
    if (!hasChildExited(child)) {
      signalChildTree(child, "SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS).unref();
}

export async function spawnClaudeSubagent(params: {
  toolCallId: string;
  description: string;
  prompt: string;
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  progressEnabled: boolean;
  onProgress: ((result: AgentToolResult) => void) | undefined;
  onUsage: (usage: SubagentUsage) => void;
  appendInstructions?: string;
  outputSchema?: unknown;
}): Promise<AgentToolResult> {
  const subagentType = params.profile.name;
  const taskPrompt = params.appendInstructions ? `${params.prompt}\n\n${params.appendInstructions}` : params.prompt;
  const emitter = createProgressEmitter({
    toolCallId: params.toolCallId,
    description: params.description,
    subagentType,
    backend: params.profile.backend,
    enabled: params.progressEnabled,
    onProgress: params.onProgress,
  });
  const progress = emitter.progress;
  let latestRawUsage = emptyTokenUsage();
  let latestCostUsd: number | undefined;
  let latestUsage = claudeUsageToSubagentUsage(latestRawUsage, latestCostUsd);
  let resultText = "";
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let sawTerminalEvent = false;
  let eventError: string | undefined;
  let oversizeError: string | undefined;
  let child: ChildProcess | undefined;
  let abortHandler: (() => void) | undefined;

  const publishUsage = (usage: ClaudeTokenUsage | undefined, costUsd: number | undefined) => {
    if (usage) {
      latestRawUsage = usage;
    }
    if (costUsd !== undefined) {
      latestCostUsd = costUsd;
    }
    latestUsage = claudeUsageToSubagentUsage(latestRawUsage, latestCostUsd);
    if (progress) {
      progress.usage = latestUsage;
    }
    params.onUsage(latestUsage);
    emitter.emitSoon();
  };
  const handleEvent = (event: Record<string, unknown>) => {
    if (event.type === "result" || event.type === "error") {
      sawTerminalEvent = true;
    }
    const activity = claudeActivityFromEvent(event);
    if (activity) {
      emitter.addActivity(activity);
      emitter.emitSoon();
    }
    const usage = extractClaudeUsage(event);
    const cost = extractClaudeCostUsd(event);
    if (usage || cost !== undefined) {
      publishUsage(usage, cost);
    }
    const text = extractClaudeFinalText(event);
    if (text !== undefined) {
      resultText = text;
      if (text.trim()) {
        emitter.addActivity(text.split("\n").find((line) => line.trim()) ?? text);
        emitter.emitSoon();
      }
    }
    const error = extractClaudeError(event);
    if (error) {
      eventError ??= error;
    }
  };

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    const args = buildClaudeArgs({
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      outputSchema: params.outputSchema,
    });

    const proc = spawn(CLAUDE_COMMAND, args, {
      cwd: params.ctx.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("claude stdin/stdout/stderr pipes were not available");
    }

    abortHandler = () => {
      abortChild(proc);
    };
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    if (params.signal?.aborted) {
      abortChild(proc);
      throw new Error("Subagent aborted before prompt start");
    }

    let stdoutBuffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdin.on("error", () => {
      // If claude exits before reading stdin, the process close/error path below
      // reports the real failure. Avoid an unhandled EPIPE on the writable side.
    });

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
        // A single newline-free line this large means the stream is unparseable.
        // Fail loudly instead of silently dropping what might be real output.
        oversizeError ??= `claude emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars without a newline; stream is unparseable`;
        stdoutBuffer = "";
        abortChild(proc);
        return;
      }
      for (const line of lines) {
        const event = parseClaudeJsonLine(line);
        if (event) {
          handleEvent(event);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuffer.append(String(chunk));
    });

    emitter.emit();
    emitter.startHeartbeat();
    proc.stdin.end(taskPrompt);

    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        if (stdoutBuffer.trim()) {
          const event = parseClaudeJsonLine(stdoutBuffer);
          if (event) {
            handleEvent(event);
          }
        }
        resolve({ code, signal });
      });
    });

    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }

    if (params.signal?.aborted) {
      throw new Error("Subagent aborted");
    }
    if (oversizeError) {
      throw new Error(oversizeError);
    }
    if (eventError) {
      throw new Error(eventError);
    }
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      throw new Error(`claude exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : ""}`);
    }
    if (!sawTerminalEvent && !resultText.trim()) {
      // Hard-fail only when claude produced nothing usable. If it exited cleanly
      // (code 0) with final text but no recognized terminal event — e.g. a CLI
      // stream-format change renamed the event — accept the output rather than
      // turning a good run into a failure.
      throw new Error("claude exited without a terminal JSON event");
    }

    params.onUsage(latestUsage);
    const result = resultText.trim() || "(no final text output)";
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = latestUsage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      status: "done",
      result,
      usage: latestUsage,
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    if (child && !hasChildExited(child)) {
      abortChild(child);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    params.onUsage(latestUsage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = latestUsage;
      progress.endedAt = Date.now();
    }
    const verb = status === "aborted" ? "aborted" : "failed";
    return textResult(`Subagent "${params.description}" (${subagentType}) ${verb}: ${message}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      status,
      error: message,
      usage: latestUsage,
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
  }
}
