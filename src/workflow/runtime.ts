import { parseWorkflowScript } from "./script-validation.ts";
import { fingerprintWorkflowAgentCall } from "./replay-cache.ts";
import { createWorkflowScriptWorker, type ParentToWorkerMessage, type WorkerToParentMessage } from "./script-worker.ts";
import {
  defaultAgentLabel,
  normalizeAgentOptions,
  normalizeJsonSerializable,
  requireString,
  truncateLogLine,
} from "./runtime-values.ts";
import type {
  RunWorkflowOptions,
  WorkflowAgentResultEvent,
  WorkflowLimits,
  WorkflowRunResult,
} from "./types.ts";

export type {
  RunWorkflowOptions,
  WorkflowAgentCall,
  WorkflowAgentResultEvent,
  WorkflowAgentRunner,
  WorkflowCachedAgentResult,
  WorkflowLimits,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunResult,
} from "./types.ts";
export { parseWorkflowScript } from "./script-validation.ts";
export { fingerprintWorkflowAgentCall, hashStableValue } from "./replay-cache.ts";

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  resumePrefixActive: boolean;
}

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
    const call = { index, prompt: taskPrompt, label, phase: assignedPhase, subagentType, schema: opts.schema };
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
    options.onAgentQueued?.({ index, label, phase: assignedPhase, subagentType, prompt: taskPrompt });
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

  const worker = createWorkflowScriptWorker({
    body,
    metaName: meta.name || "workflow",
    args: options.args,
    cwd: options.cwd,
    limits,
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

