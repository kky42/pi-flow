import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentBackend, SubagentType } from "../types.ts";

export const SUBAGENT_SESSION_KEY_CUSTOM_TYPE = "pi-flow-subagent-session-key";

export interface SessionKeyBinding {
  key: string;
  sessionId: string;
  subagentType: SubagentType;
  backend: SubagentBackend;
}

interface SessionKeyEntryData {
  version?: unknown;
  key?: unknown;
  sessionId?: unknown;
  subagentType?: unknown;
  backend?: unknown;
}

interface SessionManagerLike {
  getEntries?: () => unknown[];
  appendCustomEntry?: (customType: string, data?: unknown) => string;
}

export function normalizeSessionKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key ? key : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseBindingData(data: unknown): SessionKeyBinding | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const candidate = data as SessionKeyEntryData;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.subagentType !== "string" ||
    (candidate.backend !== "pi" && candidate.backend !== "codex" && candidate.backend !== "claude")
  ) {
    return undefined;
  }
  return {
    key: candidate.key,
    sessionId: candidate.sessionId,
    subagentType: candidate.subagentType,
    backend: candidate.backend,
  };
}

export function getPersistedSessionKeyBinding(ctx: ExtensionContext, key: string): SessionKeyBinding | undefined {
  const manager = ctx.sessionManager as SessionManagerLike | undefined;
  const entries = manager?.getEntries?.();
  if (!Array.isArray(entries)) {
    return undefined;
  }
  let latest: SessionKeyBinding | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_SESSION_KEY_CUSTOM_TYPE) {
      continue;
    }
    const binding = parseBindingData(entry.data);
    if (binding?.key === key) {
      latest = binding;
    }
  }
  return latest;
}

export function persistSessionKeyBinding(ctx: ExtensionContext, binding: SessionKeyBinding): void {
  const manager = ctx.sessionManager as SessionManagerLike | undefined;
  manager?.appendCustomEntry?.(SUBAGENT_SESSION_KEY_CUSTOM_TYPE, {
    version: 1,
    key: binding.key,
    sessionId: binding.sessionId,
    subagentType: binding.subagentType,
    backend: binding.backend,
  });
}

export function assertBindingMatchesProfile(binding: SessionKeyBinding, params: {
  subagentType: SubagentType;
  backend: SubagentBackend;
}): void {
  if (binding.subagentType !== params.subagentType || binding.backend !== params.backend) {
    throw new Error(
      `session_key "${binding.key}" already belongs to ${binding.subagentType} (${binding.backend}); ` +
        `cannot reuse it for ${params.subagentType} (${params.backend})`,
    );
  }
}

export class SessionKeyLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string | undefined, task: () => Promise<T>): Promise<T> {
    if (!key) {
      return task();
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
