import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const CODEX_COMMAND = "codex";
const FORCE_KILL_DELAY_MS = 3000;

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexModelPrice {
  /** USD per one million non-cached input tokens. */
  input: number;
  /** USD per one million cached input tokens. */
  cachedInput: number;
  /** USD per one million output tokens. */
  output: number;
}

export const CODEX_MODEL_PRICES_USD_PER_MILLION: Record<string, CodexModelPrice> = {
  "gpt-5.5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.4": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.4-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function buildConfigOverrideArg(key: string, rawValue: string): string {
  return `${key}=${JSON.stringify(rawValue)}`;
}

export function normalizeCodexPriceModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  if (!normalized) {
    return undefined;
  }
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function estimateCodexCostUsd(model: string | undefined, usage: CodexTokenUsage): number | undefined {
  const priceModel = normalizeCodexPriceModel(model);
  const price = priceModel ? CODEX_MODEL_PRICES_USD_PER_MILLION[priceModel] : undefined;
  if (!price) {
    return undefined;
  }
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const outputTokens = Math.max(0, usage.outputTokens);
  return (
    (uncachedInputTokens * price.input) +
    (cachedInputTokens * price.cachedInput) +
    (outputTokens * price.output)
  ) / 1_000_000;
}

export function codexUsageToSubagentUsage(model: string | undefined, usage: CodexTokenUsage): SubagentUsage {
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const cost = estimateCodexCostUsd(model, usage);
  const promptTokens = uncachedInputTokens + cachedInputTokens;
  return {
    input: uncachedInputTokens,
    output: Math.max(0, usage.outputTokens),
    cacheRead: cachedInputTokens,
    cacheWrite: 0,
    cost: cost ?? 0,
    costKnown: cost !== undefined,
    costEstimated: cost !== undefined,
    latestCacheHitRate: promptTokens > 0 ? (cachedInputTokens / promptTokens) * 100 : undefined,
  };
}

export function buildCodexArgs({
  prompt,
  profile,
  thinkingLevel,
  outputSchemaPath,
}: {
  prompt: string;
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  outputSchemaPath?: string;
}): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (profile.systemPrompt) {
    args.push("-c", buildConfigOverrideArg("developer_instructions", profile.systemPrompt));
  }
  if (profile.model) {
    args.push("--model", profile.model);
  }
  if (thinkingLevel) {
    args.push("-c", buildConfigOverrideArg("model_reasoning_effort", thinkingLevel));
  }
  if (outputSchemaPath) {
    args.push("--output-schema", outputSchemaPath);
  }
  // Use stdin for the task prompt: prompts can be large and may begin with
  // '-' (bullet lists), both of which are fragile as argv values.
  void prompt;
  args.push("--", "-");
  return args;
}

export function parseCodexJsonLine(line: string): Record<string, unknown> | undefined {
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

function parseUsageRecord(value: unknown): CodexTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const cachedInputTokens = asFiniteNumber(usage.cached_input_tokens ?? 0);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  const reasoningOutputTokens = asFiniteNumber(usage.reasoning_output_tokens ?? 0);
  if (inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined || reasoningOutputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

export function extractCodexUsage(event: Record<string, unknown>): CodexTokenUsage | undefined {
  if (event.type === "turn.completed") {
    return parseUsageRecord(event.usage);
  }
  if (event.type !== "event_msg") {
    return undefined;
  }
  const payload = asRecord(event.payload);
  if (!payload || payload.type !== "token_count") {
    return undefined;
  }
  const info = asRecord(payload.info);
  return info ? parseUsageRecord(info.last_token_usage) : undefined;
}

function textFromCodexValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(textFromCodexValue).filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  if (record.type === "text" && typeof record.content === "string") {
    return record.content;
  }
  return undefined;
}

function structuredTextFromCodexValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function extractCodexFinalText(event: Record<string, unknown>): string | undefined {
  const item = asRecord(event.item);
  if (event.type !== "item.completed" || !item || item.type !== "agent_message") {
    return undefined;
  }
  return (
    textFromCodexValue(item.text) ??
    textFromCodexValue(item.message) ??
    textFromCodexValue(item.content) ??
    structuredTextFromCodexValue(item.structured_content) ??
    ""
  );
}

export function extractCodexError(event: Record<string, unknown>): string | undefined {
  if (event.type === "turn.failed") {
    const error = asRecord(event.error);
    return `Codex failed: ${typeof error?.message === "string" ? error.message : "turn failed"}`;
  }
  if (event.type === "error") {
    return `Codex error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
  }
  return undefined;
}

function getPreviewFromRecord(record: Record<string, unknown>): string {
  const candidates = [
    record.command,
    record.cmd,
    record.path,
    record.pattern,
    record.query,
    record.text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.replace(/\s+/g, " ").trim();
    }
  }
  const input = asRecord(record.input) ?? asRecord(record.arguments) ?? asRecord(record.args);
  return input ? getPreviewFromRecord(input) : "";
}

export function codexActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "thread.started") {
    return "codex session started";
  }
  if (event.type === "turn.completed") {
    return "codex turn completed";
  }
  const item = asRecord(event.item);
  if ((event.type === "item.started" || event.type === "item.completed") && item && item.type !== "agent_message") {
    const itemType = typeof item.type === "string" ? item.type : "item";
    const preview = getPreviewFromRecord(item);
    return `${itemType}${preview ? ` ${preview}` : ""}`;
  }
  const error = extractCodexError(event);
  return error ? error : undefined;
}

function emptyUsage(model: string | undefined): SubagentUsage {
  return codexUsageToSubagentUsage(model, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  });
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

async function createOutputSchemaFile(schema: unknown): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
  if (schema === undefined || schema === null) {
    return undefined;
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-codex-schema-"));
  const schemaPath = join(dir, "schema.json");
  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  return {
    path: schemaPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function spawnCodexSubagent(params: {
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
  let latestUsage = emptyUsage(params.profile.model);
  let resultText = "";
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let sawTerminalEvent = false;
  let eventError: string | undefined;
  let diagnosticError: string | undefined;
  let oversizeError: string | undefined;
  let child: ChildProcess | undefined;
  let schemaFile: Awaited<ReturnType<typeof createOutputSchemaFile>> = undefined;
  let abortHandler: (() => void) | undefined;

  const handleEvent = (event: Record<string, unknown>) => {
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      sawTerminalEvent = true;
    }
    const activity = codexActivityFromEvent(event);
    if (activity) {
      emitter.addActivity(activity);
      emitter.emitSoon();
    }
    const usage = extractCodexUsage(event);
    if (usage) {
      latestUsage = codexUsageToSubagentUsage(params.profile.model, usage);
      if (progress) {
        progress.usage = latestUsage;
      }
      params.onUsage(latestUsage);
      emitter.emitSoon();
    }
    const text = extractCodexFinalText(event);
    if (text !== undefined) {
      resultText = text;
      if (text.trim()) {
        emitter.addActivity(text.split("\n").find((line) => line.trim()) ?? text);
        emitter.emitSoon();
      }
    }
    if (event.type === "turn.failed") {
      eventError ??= extractCodexError(event);
    } else if (event.type === "error") {
      diagnosticError ??= extractCodexError(event);
    }
  };

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    schemaFile = await createOutputSchemaFile(params.outputSchema);
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    const args = buildCodexArgs({
      prompt: taskPrompt,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      outputSchemaPath: schemaFile?.path,
    });

    const proc = spawn(CODEX_COMMAND, args, {
      cwd: params.ctx.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("codex stdin/stdout/stderr pipes were not available");
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
      // If codex exits before reading stdin, the process close/error path below
      // reports the real failure. Avoid an unhandled EPIPE on the writable side.
    });

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
        // A single newline-free line this large means the stream is unparseable.
        // Fail loudly instead of silently dropping what might be real output.
        oversizeError ??= `codex emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars without a newline; stream is unparseable`;
        stdoutBuffer = "";
        abortChild(proc);
        return;
      }
      for (const line of lines) {
        const event = parseCodexJsonLine(line);
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
          const event = parseCodexJsonLine(stdoutBuffer);
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
      const diagnostic = diagnosticError ? `: ${diagnosticError}` : "";
      throw new Error(`codex exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : diagnostic}`);
    }
    if (!sawTerminalEvent && !resultText.trim()) {
      // Hard-fail only when codex produced nothing usable. If it exited cleanly
      // (code 0) with final text but no recognized terminal event — e.g. a CLI
      // stream-format change renamed the event — accept the output rather than
      // turning a good run into a failure.
      throw new Error(diagnosticError ?? "codex exited without a terminal JSON event");
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
    await schemaFile?.cleanup().catch(() => undefined);
  }
}
