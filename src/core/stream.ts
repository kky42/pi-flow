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
export const MAX_STDERR_CHARS = 128 * 1024;

/**
 * Max length of a single un-terminated stdout line. Line-delimited JSON events
 * are far smaller than this; a line this large without a newline means the
 * stream is broken, so the backend aborts the child and fails the run with a
 * clear error rather than buffering forever (or silently dropping real output).
 */
export const MAX_STDOUT_LINE_CHARS = 4 * 1024 * 1024;

export interface BoundedBuffer {
  /** Append a chunk; content past the cap is dropped from the middle. */
  append(chunk: string): void;
  /**
   * The retained text. When the input exceeded the cap, the head and the tail
   * are both kept with an elision marker between them, so the start AND the end
   * of a failure (where the real error usually is) survive truncation.
   */
  text(): string;
  /** Whether any input was dropped. */
  overflowed(): boolean;
}

export function createBoundedBuffer(maxChars: number): BoundedBuffer {
  const headLimit = Math.ceil(maxChars / 2);
  const tailLimit = Math.max(0, maxChars - headLimit);
  let head = "";
  let tail = "";
  // Total chars routed to the tail before the rolling cap dropped any; used to
  // decide whether the middle was actually elided.
  let tailRawLen = 0;

  return {
    append(chunk) {
      if (!chunk) {
        return;
      }
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (chunk) {
        tailRawLen += chunk.length;
        tail = (tail + chunk).slice(-tailLimit);
      }
    },
    text() {
      if (tailRawLen === 0) {
        return head;
      }
      if (tailRawLen <= tailLimit) {
        return head + tail;
      }
      return `${head}\n…[truncated]\n${tail}`;
    },
    overflowed: () => tailRawLen > tailLimit,
  };
}
