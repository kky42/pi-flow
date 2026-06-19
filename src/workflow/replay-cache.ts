import { createHash } from "node:crypto";
import type { WorkflowAgentCall } from "./types.ts";

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
