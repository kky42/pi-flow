import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { parse, type Node } from "acorn";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
}

/** A single agent() invocation requested by a workflow script. */
export interface WorkflowAgentCall {
  prompt: string;
  label: string;
  phase?: string;
  subagentType: string;
  /** JSON Schema for structured output from the child subagent. */
  schema?: unknown;
}

export interface WorkflowCachedAgentResult {
  index: number;
  fingerprint: string;
  result: unknown;
  failed?: boolean;
}

export interface WorkflowAgentResultEvent extends WorkflowCachedAgentResult {
  label: string;
  phase?: string;
  subagentType: string;
  prompt: string;
  schema?: unknown;
  cached: boolean;
}

/**
 * Runs one subagent and resolves with its final text. The workflow tool
 * supplies the real implementation (profile resolution + spawnSubagent); tests
 * inject a fake. Throwing is treated as a per-agent failure (the branch becomes
 * null and is logged) unless the workflow signal aborted.
 */
export type WorkflowAgentRunner = (
  call: WorkflowAgentCall,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

export interface WorkflowLimits {
  /** Hard cap on agent() calls per workflow run, including cached calls. */
  maxAgentCalls: number;
  /** Retained workflow log lines. Further logs are summarized/truncated. */
  maxLogs: number;
  /** Maximum retained characters per workflow log line. */
  maxLogLength: number;
  /** Heartbeat sent by the isolated script worker. */
  workerHeartbeatIntervalMs: number;
  /** Kill the isolated script worker only after this much heartbeat silence. */
  workerStallTimeoutMs: number;
  /** Kill a responsive script that makes no workflow progress and has no active agent calls. */
  workerIdleTimeoutMs: number;
  /** Initial synchronous vm execution timeout before the script's first await. */
  syncExecutionTimeoutMs: number;
  /** Old-generation V8 heap cap for the workflow script worker. */
  workerMaxOldGenerationSizeMb: number;
  /** Young-generation V8 heap cap for the workflow script worker. */
  workerMaxYoungGenerationSizeMb: number;
  /** Worker stack cap. */
  workerStackSizeMb: number;
  /** Cooperative abort grace period before terminating an unresponsive worker. */
  abortGraceMs: number;
}

export interface RunWorkflowOptions {
  args?: unknown;
  cwd: string;
  signal?: AbortSignal;
  /** Shared global concurrency cap; agent() queues on this. */
  limiter: ConcurrencyLimiter;
  runAgent: WorkflowAgentRunner;
  defaultSubagentType?: string;
  limits?: Partial<WorkflowLimits>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  resumeAgentResults?: WorkflowCachedAgentResult[];
  onAgentStart?: (event: { index: number; label: string; phase?: string; subagentType: string; prompt: string; cached?: boolean }) => void;
  onAgentEnd?: (event: { index: number; label: string; phase?: string; result: unknown; cached?: boolean; failed?: boolean }) => void;
  onAgentResult?: (event: WorkflowAgentResultEvent) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  resumePrefixActive: boolean;
}

interface NormalizedAgentOptions {
  label?: string;
  phase?: string;
  subagentType?: string;
  schema?: unknown;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

type WorkerToParentMessage =
  | { type: "heartbeat" }
  | { type: "agent"; id: number; prompt: unknown; options: unknown }
  | { type: "log"; message: unknown }
  | { type: "phase"; title: unknown }
  | { type: "fatal"; error: string }
  | { type: "complete"; result: unknown }
  | { type: "error"; error: string };

type ParentToWorkerMessage =
  | { type: "agentResult"; id: number; ok: true; result: unknown }
  | { type: "agentResult"; id: number; ok: false; error: string; fatal?: boolean }
  | { type: "abort"; reason: string };

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

const DEFAULT_SUBAGENT_TYPE = "general-purpose";

const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxAgentCalls: 1_000,
  maxLogs: 500,
  maxLogLength: 4_000,
  workerHeartbeatIntervalMs: 250,
  workerStallTimeoutMs: 60_000,
  workerIdleTimeoutMs: 300_000,
  syncExecutionTimeoutMs: 5_000,
  workerMaxOldGenerationSizeMb: 512,
  workerMaxYoungGenerationSizeMb: 32,
  workerStackSizeMb: 4,
  abortGraceMs: 1_000,
};

class WorkflowFatalError extends Error {
  readonly workflowFatal = true;
}

export class WorkflowAbortError extends WorkflowFatalError {
  readonly workflowAbort = true;
}

function isWorkflowFatalError(error: unknown): error is WorkflowFatalError {
  return error instanceof WorkflowFatalError;
}

export function isWorkflowAbortError(error: unknown): error is WorkflowAbortError {
  return error instanceof WorkflowAbortError;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<T>> {
  const { meta, body } = parseWorkflowScript(script);
  const limits = normalizeWorkflowLimits(options.limits);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    resumePrefixActive: Boolean(options.resumeAgentResults?.length),
  };
  const resumeAgentResults = options.resumeAgentResults ?? [];
  const limiter = options.limiter;
  const defaultSubagentType = options.defaultSubagentType ?? DEFAULT_SUBAGENT_TYPE;
  const runtimeAbortController = new AbortController();
  const compositeSignal = AbortSignal.any(
    [options.signal, runtimeAbortController.signal].filter((signal): signal is AbortSignal => Boolean(signal)),
  );
  let abortReason = "workflow aborted";
  let fatalError: Error | undefined;

  const rememberFatal = (error: Error) => {
    if (!fatalError) {
      fatalError = error;
    }
    abortReason = error.message || abortReason;
  };

  const abortRuntime = (error: Error) => {
    rememberFatal(error);
    if (!runtimeAbortController.signal.aborted) {
      runtimeAbortController.abort();
    }
  };

  const throwIfAborted = () => {
    if (options.signal?.aborted || runtimeAbortController.signal.aborted) {
      throw fatalError ?? new WorkflowFatalError(abortReason);
    }
  };

  const log = (message: unknown) => {
    const text = truncateLogLine(String(message), limits.maxLogLength);
    if (state.logs.length < limits.maxLogs) {
      state.logs.push(text);
      options.onLog?.(text);
      return;
    }
    if (state.logs.length === limits.maxLogs) {
      const truncated = `workflow logs truncated after ${limits.maxLogs} entries`;
      state.logs.push(truncated);
      options.onLog?.(truncated);
    }
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) {
      state.phases.push(text);
    }
    options.onPhase?.(text);
  };

  const recordAgentResult = async (event: WorkflowAgentResultEvent) => {
    try {
      await options.onAgentResult?.(event);
    } catch (error) {
      log(`workflow agent-result hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runAgentCall = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    if (state.agentCount >= limits.maxAgentCalls) {
      const error = new WorkflowFatalError(`maximum workflow agent calls exceeded (${limits.maxAgentCalls})`);
      abortRuntime(error);
      throw error;
    }
    const taskPrompt = requireString(prompt, "agent prompt");
    const opts = normalizeAgentOptions(agentOptions);
    const assignedPhase = opts.phase ?? state.currentPhase;
    const subagentType = opts.subagentType ?? defaultSubagentType;

    const index = ++state.agentCount;
    const label = opts.label || defaultAgentLabel(assignedPhase, index);
    const call = { prompt: taskPrompt, label, phase: assignedPhase, subagentType, schema: opts.schema };
    const fingerprint = fingerprintWorkflowAgentCall(call);
    const cachedResult = state.resumePrefixActive ? resumeAgentResults[index - 1] : undefined;
    if (cachedResult?.index === index && cachedResult.fingerprint === fingerprint && !cachedResult.failed) {
      options.onAgentStart?.({ index, label, phase: assignedPhase, subagentType, prompt: taskPrompt, cached: true });
      options.onAgentEnd?.({ index, label, phase: assignedPhase, result: cachedResult.result, cached: true, failed: false });
      await recordAgentResult({ ...call, index, fingerprint, result: cachedResult.result, failed: false, cached: true });
      return cachedResult.result;
    }
    state.resumePrefixActive = false;

    // Queue on the shared global cap. May reject if aborted while waiting.
    const release = await limiter.acquire(compositeSignal);
    let result: unknown;
    let failed = false;
    try {
      options.onAgentStart?.({ index, label, phase: assignedPhase, subagentType, prompt: taskPrompt });
      throwIfAborted();
      result = await options.runAgent(call, compositeSignal);
      throwIfAborted();
      result = normalizeJsonSerializable(result, "agent result");
    } catch (error) {
      if (options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error)) {
        throw error;
      }
      log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      result = null;
      failed = true;
    } finally {
      release();
    }
    options.onAgentEnd?.({ index, label, phase: assignedPhase, result, failed, cached: false });
    await recordAgentResult({ ...call, index, fingerprint, result, failed, cached: false });
    return result;
  };

  const worker = new Worker(WORKFLOW_WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaName: meta.name || "workflow",
      args: options.args,
      cwd: options.cwd,
      maxAgentCalls: limits.maxAgentCalls,
      maxLogs: limits.maxLogs,
      maxLogLength: limits.maxLogLength,
      heartbeatIntervalMs: limits.workerHeartbeatIntervalMs,
      syncExecutionTimeoutMs: limits.syncExecutionTimeoutMs,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: limits.workerMaxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.workerMaxYoungGenerationSizeMb,
      stackSizeMb: limits.workerStackSizeMb,
    },
  });

  return await new Promise<WorkflowRunResult<T>>((resolve, reject) => {
    let finished = false;
    let lastHeartbeat = Date.now();
    let lastProgressAt = Date.now();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const activeAgentTasks = new Set<Promise<void>>();

    const cleanup = () => {
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      if (stallTimer) {
        clearInterval(stallTimer);
      }
      worker.removeAllListeners();
    };

    const finishReject = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      abortRuntime(isWorkflowFatalError(error) ? error : new WorkflowFatalError(error.message));
      cleanup();
      void worker.terminate();
      reject(error);
    };

    const finishResolve = (result: unknown) => {
      if (finished) {
        return;
      }
      let normalizedResult: unknown;
      try {
        throwIfAborted();
        if (fatalError) {
          throw fatalError;
        }
        if (state.agentCount === 0) {
          throw new Error("workflow must call agent() at least once");
        }
        normalizedResult = normalizeJsonSerializable(result, "workflow result");
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      finished = true;
      cleanup();
      void worker.terminate();
      resolve({
        meta,
        result: normalizedResult as T,
        logs: state.logs,
        phases: state.phases,
        agentCount: state.agentCount,
      });
    };

    const abortWorkflow = (reason: string) => {
      if (finished) {
        return;
      }
      const error = new WorkflowAbortError(reason);
      abortRuntime(error);
      postToWorker({ type: "abort", reason });
      if (!abortTimer) {
        abortTimer = setTimeout(() => {
          finishReject(error);
        }, limits.abortGraceMs);
        abortTimer.unref?.();
      }
    };

    const onExternalAbort = () => abortWorkflow("workflow aborted");
    if (options.signal?.aborted) {
      abortWorkflow("workflow aborted");
    } else {
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const watchdogIntervalMs = Math.max(
      10,
      Math.min(1_000, Math.floor(Math.min(limits.workerStallTimeoutMs, limits.workerIdleTimeoutMs) / 4)),
    );
    stallTimer = setInterval(() => {
      if (finished) {
        return;
      }
      const now = Date.now();
      const silentFor = now - lastHeartbeat;
      if (silentFor >= limits.workerStallTimeoutMs) {
        finishReject(new WorkflowFatalError(`workflow script worker stalled for ${silentFor}ms`));
        return;
      }
      const idleFor = now - lastProgressAt;
      if (activeAgentTasks.size === 0 && idleFor >= limits.workerIdleTimeoutMs) {
        finishReject(new WorkflowFatalError(`workflow script made no progress for ${idleFor}ms`));
      }
    }, watchdogIntervalMs);
    stallTimer.unref?.();

    function postToWorker(message: ParentToWorkerMessage): void {
      if (finished) {
        return;
      }
      try {
        worker.postMessage(message);
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    function handleAgentRequest(message: Extract<WorkerToParentMessage, { type: "agent" }>): void {
      const task = (async () => {
        try {
          const result = await runAgentCall(message.prompt, message.options);
          lastProgressAt = Date.now();
          postToWorker({ type: "agentResult", id: message.id, ok: true, result });
        } catch (error) {
          const fatal = options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error);
          if (fatal) {
            rememberFatal(error instanceof Error ? error : new WorkflowFatalError(String(error)));
          }
          lastProgressAt = Date.now();
          postToWorker({
            type: "agentResult",
            id: message.id,
            ok: false,
            fatal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })().finally(() => {
        activeAgentTasks.delete(task);
      });
      activeAgentTasks.add(task);
    }

    worker.on("message", (message: WorkerToParentMessage) => {
      if (finished || !message || typeof message !== "object") {
        return;
      }
      try {
        switch (message.type) {
          case "heartbeat":
            lastHeartbeat = Date.now();
            break;
          case "agent":
            lastProgressAt = Date.now();
            handleAgentRequest(message);
            break;
          case "log":
            lastProgressAt = Date.now();
            log(message.message);
            break;
          case "phase":
            lastProgressAt = Date.now();
            phase(message.title);
            break;
          case "fatal":
            lastProgressAt = Date.now();
            abortRuntime(new WorkflowFatalError(message.error));
            break;
          case "complete":
            lastProgressAt = Date.now();
            finishResolve(message.result);
            break;
          case "error":
            finishReject(fatalError ?? new Error(message.error));
            break;
        }
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    worker.on("error", (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on("exit", (code) => {
      if (!finished && code !== 0) {
        finishReject(fatalError ?? new Error(`workflow script worker exited with code ${code}`));
      }
    });
  });
}

function normalizeWorkflowLimits(limits: Partial<WorkflowLimits> | undefined): WorkflowLimits {
  const normalized = { ...DEFAULT_WORKFLOW_LIMITS, ...(limits ?? {}) };
  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new Error(`workflow limit ${key} must be a positive integer`);
    }
  }
  return normalized;
}

function truncateLogLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as unknown as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) {
    throw new Error("meta must have a literal value");
  }

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(node: AnyNode): void {
  if (isNondeterministicReference(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }
  for (const child of astChildren(node)) {
    assertDeterministicAst(child);
  }
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      children.push(...value.filter(isAstNode));
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

// Determinism is the only invariant this scan enforces. Resume-by-replay assumes
// a cooperative script reproduces the same agent() calls from the same inputs,
// so direct references to the two common host sources of nondeterminism are
// rejected: `new Date()`, `Date()`, `Date.now`, simple `Date` aliases, and
// static `Math.random`. This is not a security sandbox; workflows are trusted
// code and clever code can bypass a lint-style AST scan.
function isNondeterministicReference(node: AnyNode): boolean {
  if (isStaticMathRandomReference(node)) {
    return true;
  }
  if (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date") {
    return true;
  }
  if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date") {
    return true;
  }
  if (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "Date") {
    return true;
  }
  if (node.type === "VariableDeclarator" && node.init?.type === "Identifier" && node.init.name === "Date") {
    return true;
  }
  if (node.type === "AssignmentExpression" && node.right?.type === "Identifier" && node.right.name === "Date") {
    return true;
  }
  return false;
}

function isStaticMathRandomReference(node: AnyNode): boolean {
  return (
    node.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    node.object.name === "Math" &&
    propertyNameOf(node) === "random"
  );
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

export function fingerprintWorkflowAgentCall(call: WorkflowAgentCall): string {
  return hashStableValue({
    prompt: call.prompt,
    label: call.label,
    phase: call.phase,
    subagentType: call.subagentType,
    schema: call.schema,
  });
}

export function hashStableValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "function") return { $type: "function" };
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return { $type: "circular" };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForStableStringify(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeForStableStringify((value as Record<string, unknown>)[key], seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): NormalizedAgentOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as Record<string, unknown>;
  return {
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    subagentType: optionalString(options.subagent_type, "agent subagent_type"),
    schema: options.schema,
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function normalizeJsonSerializable(value: unknown, name: string): unknown {
  try {
    const normalized = normalizeJsonValue(value, name, new WeakSet<object>(), false);
    if (normalized === undefined) {
      throw new Error(`${name} is undefined; return null when there is intentionally no result`);
    }
    return normalized;
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`${name} must be JSON-serializable.${detail}`);
  }
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  insideArray: boolean,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
      return insideArray ? null : undefined;
    case "bigint":
    case "function":
    case "symbol":
      throw new Error(`${path} contains ${typeof value}`);
    case "object":
      break;
  }
  if (seen.has(value as object)) {
    throw new Error(`${path} contains a circular reference`);
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`, seen, true));
    }
    if (!isPlainJsonObject(value)) {
      const proto = Object.getPrototypeOf(value);
      throw new Error(`${path} contains non-plain object ${proto?.constructor?.name ?? "unknown"}`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeJsonValue(child, `${path}.${key}`, seen, false);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

function isPlainJsonObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.prototype.toString.call(value) === "[object Object]";
}

const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

class WorkflowFatalError extends Error {}

let acceptingAgentCalls = true;
let aborted = false;
let fatalErrorMessage = undefined;
let nextAgentId = 0;
let startedAgentCount = 0;
const pendingAgents = new Map();
const agentObservations = [];

const heartbeat = setInterval(() => {
  post({ type: "heartbeat" });
}, workerData.heartbeatIntervalMs);
heartbeat.unref?.();
post({ type: "heartbeat" });

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "agentResult") {
    const pending = pendingAgents.get(message.id);
    if (!pending) return;
    pendingAgents.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = message.fatal ? new WorkflowFatalError(message.error) : new Error(message.error);
      pending.reject(error);
    }
    return;
  }
  if (message.type === "abort") {
    markFatal(message.reason || "workflow aborted");
  }
});

function post(message) {
  parentPort.postMessage(message);
}

function postError(error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    post({ type: "error", error: message });
  } finally {
    clearInterval(heartbeat);
  }
}

function markFatal(message) {
  fatalErrorMessage = fatalErrorMessage || message || "workflow aborted";
  aborted = true;
  acceptingAgentCalls = false;
  for (const pending of pendingAgents.values()) {
    pending.reject(new WorkflowFatalError(fatalErrorMessage));
  }
  pendingAgents.clear();
  post({ type: "fatal", error: fatalErrorMessage });
}

function throwIfFatal() {
  if (aborted || fatalErrorMessage) {
    throw new WorkflowFatalError(fatalErrorMessage || "workflow aborted");
  }
}

function requireString(value, name) {
  if (typeof value !== "string") throw new TypeError(name + " must be a string");
  return value;
}

let retainedLogCount = 0;

function truncateLogLine(text) {
  if (text.length <= workerData.maxLogLength) return text;
  return text.slice(0, Math.max(0, workerData.maxLogLength - 1)) + "…";
}

function log(message) {
  if (retainedLogCount > workerData.maxLogs) return;
  if (retainedLogCount === workerData.maxLogs) {
    retainedLogCount++;
    post({ type: "log", message: "workflow logs truncated after " + workerData.maxLogs + " entries" });
    return;
  }
  retainedLogCount++;
  post({ type: "log", message: truncateLogLine(String(message)) });
}

function phase(title) {
  post({ type: "phase", title: requireString(title, "phase title") });
}

function requestAgent(prompt, options) {
  throwIfFatal();
  if (startedAgentCount >= workerData.maxAgentCalls) {
    markFatal("maximum workflow agent calls exceeded (" + workerData.maxAgentCalls + ")");
    throwIfFatal();
  }
  startedAgentCount++;
  const id = ++nextAgentId;
  return new Promise((resolve, reject) => {
    pendingAgents.set(id, { resolve, reject });
    post({ type: "agent", id, prompt, options });
  });
}

function agent(prompt, agentOptions = {}) {
  if (!acceptingAgentCalls) {
    throw new Error("agent() cannot be called after the workflow body has returned");
  }
  const observation = { observed: false, settled: false, promise: undefined };
  agentObservations.push(observation);
  const start = () => {
    observation.observed = true;
    if (!acceptingAgentCalls) {
      return Promise.reject(new Error("agent() cannot be called after the workflow body has returned"));
    }
    if (!observation.promise) {
      observation.promise = requestAgent(prompt, agentOptions).finally(() => {
        observation.settled = true;
      });
    }
    return observation.promise;
  };
  return {
    then: (onFulfilled, onRejected) => start().then(onFulfilled, onRejected),
    catch: (onRejected) => start().catch(onRejected),
    finally: (onFinally) => start().finally(onFinally),
    [Symbol.toStringTag]: "Promise",
  };
}

async function parallel(thunks) {
  throwIfFatal();
  if (!Array.isArray(thunks)) {
    throw new TypeError("parallel() expects an array of functions");
  }
  if (thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
  }
  const results = await Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return { status: "ok", value: await thunk() };
      } catch (error) {
        if (error instanceof WorkflowFatalError || aborted || fatalErrorMessage) {
          return { status: "fatal", error };
        }
        log("parallel[" + index + "] failed: " + (error instanceof Error ? error.message : String(error)));
        return { status: "ok", value: null };
      }
    }),
  );
  const fatal = results.find((result) => result.status === "fatal");
  if (fatal) {
    throw fatal.error;
  }
  return results.map((result) => result.value);
}

async function pipeline(items, ...stages) {
  throwIfFatal();
  if (!Array.isArray(items)) {
    throw new TypeError("pipeline() expects an array as the first argument");
  }
  if (stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
  }
  const results = await Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          throwIfFatal();
          value = await stage(value, item, index);
          throwIfFatal();
        } catch (error) {
          if (error instanceof WorkflowFatalError || aborted || fatalErrorMessage) {
            return { status: "fatal", error };
          }
          log("pipeline[" + index + "] failed: " + (error instanceof Error ? error.message : String(error)));
          return { status: "ok", value: null };
        }
      }
      return { status: "ok", value };
    }),
  );
  const fatal = results.find((result) => result.status === "fatal");
  if (fatal) {
    throw fatal.error;
  }
  return results.map((result) => result.value);
}

const safeMath = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter((name) => name !== "random")
    .map((name) => [name, Math[name]])
));

const context = vm.createContext(
  {
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: workerData.args,
    cwd: workerData.cwd,
    process: Object.freeze({ cwd: () => workerData.cwd }),
    console: {
      log,
      info: log,
      warn: (m) => log("[warn] " + String(m)),
      error: (m) => log("[error] " + String(m)),
    },
    JSON,
    Math: safeMath,
    Date: undefined,
    eval: undefined,
    Function: undefined,
    Reflect: undefined,
    globalThis: undefined,
  },
  { codeGeneration: { strings: false, wasm: false } },
);

function normalizeJsonSerializable(value, name) {
  try {
    const normalized = normalizeJsonValue(value, name, new WeakSet(), false);
    if (normalized === undefined) {
      throw new Error(name + " is undefined; return null when there is intentionally no result");
    }
    return normalized;
  } catch (error) {
    throw new Error(name + " must be JSON-serializable. " + (error instanceof Error ? error.message : String(error)));
  }
}

function normalizeJsonValue(value, path, seen, insideArray) {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
      return insideArray ? null : undefined;
    case "bigint":
    case "function":
    case "symbol":
      throw new Error(path + " contains " + typeof value);
    case "object":
      break;
  }
  if (seen.has(value)) {
    throw new Error(path + " contains a circular reference");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, path + "[" + index + "]", seen, true));
    }
    if (!isPlainJsonObject(value)) {
      const proto = Object.getPrototypeOf(value);
      throw new Error(path + " contains non-plain object " + (proto?.constructor?.name || "unknown"));
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeJsonValue(child, path + "." + key, seen, false);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function isPlainJsonObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.prototype.toString.call(value) === "[object Object]";
}

(async () => {
  try {
    const wrapped = "(async () => {\n" + workerData.body + "\n})()";
    const result = await new vm.Script(wrapped, { filename: (workerData.metaName || "workflow") + ".js" }).runInContext(context, {
      timeout: workerData.syncExecutionTimeoutMs,
    });
    acceptingAgentCalls = false;
    throwIfFatal();
    if (agentObservations.some((observation) => !observation.observed)) {
      throw new Error("every agent() call must be awaited or returned");
    }
    const pending = agentObservations
      .filter((observation) => observation.observed && !observation.settled && observation.promise)
      .map((observation) => observation.promise);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
      throw new Error("every started agent() call must be awaited before the workflow returns");
    }
    throwIfFatal();
    const normalizedResult = normalizeJsonSerializable(result, "workflow result");
    post({ type: "complete", result: normalizedResult });
    clearInterval(heartbeat);
  } catch (error) {
    acceptingAgentCalls = false;
    postError(error);
  }
})();
`;
