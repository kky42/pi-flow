/**
 * Bounded text accumulation for external-CLI child output.
 *
 * The codex/claude backends read child stdout/stderr in the PARENT process. A
 * verbose or crash-looping child (or one that emits a giant newline-free blob)
 * would otherwise grow the parent's resident memory without bound. These caps
 * keep a single runaway subagent from OOM-ing the host pi process. The workflow
 * worker's memory cap explicitly excludes subprocess memory, and the `Agent`
 * path has no cap at all, so the guard has to live here.
 */

/** Max characters of child stderr retained for diagnostics. */
export const MAX_STDERR_CHARS = 64 * 1024;

/**
 * Max length of a single un-terminated stdout line. Line-delimited JSON events
 * are far smaller than this; anything larger cannot be a valid event, so it is
 * dropped rather than buffered forever while waiting for a newline.
 */
export const MAX_STDOUT_LINE_CHARS = 1024 * 1024;

export interface BoundedBuffer {
  /** Append a chunk, silently discarding anything past the cap. */
  append(chunk: string): void;
  /** The retained text, with a truncation marker appended when capped. */
  text(): string;
  /** Whether any input was dropped. */
  overflowed(): boolean;
}

export function createBoundedBuffer(maxChars: number): BoundedBuffer {
  let value = "";
  let overflowed = false;
  return {
    append(chunk) {
      if (overflowed || !chunk) {
        return;
      }
      const remaining = maxChars - value.length;
      if (chunk.length <= remaining) {
        value += chunk;
        return;
      }
      value += chunk.slice(0, Math.max(0, remaining));
      overflowed = true;
    },
    text() {
      return overflowed ? `${value}\n…[truncated]` : value;
    },
    overflowed: () => overflowed,
  };
}
