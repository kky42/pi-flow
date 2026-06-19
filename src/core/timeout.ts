import type { SubagentToolDetails } from "../types.ts";

export interface TimeoutSignalState {
  signal: AbortSignal | undefined;
  timedOut: () => boolean;
  cleanup: () => void;
}

export function formatDurationMs(ms: number): string {
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms % 1_000 === 0) {
    const seconds = ms / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${ms}ms`;
}

export function subagentTimeoutMessage(timeoutMs: number): string {
  return `Subagent timed out after ${formatDurationMs(timeoutMs)}`;
}

export function createTimeoutSignal(baseSignal: AbortSignal | undefined, timeoutMs: number, description: string): TimeoutSignalState {
  if (timeoutMs <= 0 || baseSignal?.aborted) {
    return { signal: baseSignal, timedOut: () => false, cleanup: () => undefined };
  }

  const timeoutController = new AbortController();
  let timedOut = false;
  let cleanedUp = false;
  const timer = setTimeout(() => {
    timedOut = true;
    removeBaseAbortListener();
    timeoutController.abort(new Error(`Subagent "${description}" timed out after ${formatDurationMs(timeoutMs)}`));
  }, timeoutMs);
  timer.unref?.();

  const clearTimer = () => {
    clearTimeout(timer);
  };
  const onBaseAbort = () => {
    if (!timedOut) {
      clearTimer();
    }
    removeBaseAbortListener();
  };
  function removeBaseAbortListener(): void {
    baseSignal?.removeEventListener("abort", onBaseAbort);
  }

  baseSignal?.addEventListener("abort", onBaseAbort, { once: true });

  const signal = baseSignal
    ? AbortSignal.any([baseSignal, timeoutController.signal])
    : timeoutController.signal;

  return {
    signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearTimer();
      removeBaseAbortListener();
    },
  };
}

export function markSubagentTimedOut(
  details: SubagentToolDetails,
  timeoutMs: number,
): SubagentToolDetails & { status: "aborted"; error: string } {
  const message = subagentTimeoutMessage(timeoutMs);
  const progress = details.progress
    ? (() => {
        const { result: _result, ...rest } = details.progress;
        return {
          ...rest,
          status: "aborted" as const,
          error: message,
          endedAt: rest.endedAt ?? Date.now(),
        };
      })()
    : undefined;
  const { result: _result, ...rest } = details;
  return {
    ...rest,
    status: "aborted",
    error: message,
    ...(progress ? { progress } : {}),
  };
}
