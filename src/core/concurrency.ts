/**
 * A shared in-flight concurrency limiter (semaphore + FIFO wait-queue).
 *
 * One instance is shared across the `Agent` tool and the `workflow` tool so the
 * global cap bounds the total number of concurrent subagents across both entry
 * points — not per-tool.
 *
 * Two acquisition modes, by design:
 * - `tryAcquire()` — synchronous, non-blocking. Returns a release fn if a slot
 *   is free, else `null`. Kept for direct semaphore-style callers/tests.
 * - `acquire(signal?)` — async. Resolves with a release fn when a slot frees.
 *   Used by both the `Agent` tool and workflow `agent()` calls so excess
 *   subagents queue and drain under the shared cap. Honors an AbortSignal.
 *
 * Correctness / no over-subscription: `active` is incremented only on the fast
 * path while `active < max`. A release hands its slot directly to the next
 * waiter WITHOUT decrementing, so the slot transfers rather than reopening.
 * Therefore `active` never exceeds `max`. All mutations are synchronous; the
 * only async boundary is `acquire()`'s wait, and a waiter is resumed solely by a
 * hand-off that has already reserved the slot — so no two callers can claim the
 * same slot, even if a synchronous `tryAcquire()` runs in the window between a
 * release and the woken waiter's continuation.
 */
export type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const ABORT_MESSAGE = "Aborted while waiting for a concurrency slot";

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("ConcurrencyLimiter max must be a positive integer");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  /** Synchronous, non-blocking. Returns a release fn, or null if at capacity. */
  tryAcquire(): Release | null {
    if (this.active >= this.max) {
      return null;
    }
    this.active++;
    return this.makeRelease();
  }

  /** Async. Resolves with a release fn once a slot is available. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) {
      return Promise.reject(new Error(ABORT_MESSAGE));
    }
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false, signal };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(new Error(ABORT_MESSAGE));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.handOffOrDecrement();
    };
  }

  private handOffOrDecrement(): void {
    // Transfer the freed slot to the next live waiter without decrementing; the
    // waiter inherits the in-use slot, so `active` stays bounded by `max`.
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) {
        continue;
      }
      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this.makeRelease());
      return;
    }
    this.active--;
  }
}
