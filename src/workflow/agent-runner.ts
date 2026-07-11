import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../core/spawn.ts";
import { assertBindingMatchesProfile, SessionKeyLocks, type SessionKeyBinding } from "../core/session-key.ts";
import { resolveProfileModel, usesPiBackend } from "../core/model.ts";
import type { SubagentBackend, SubagentProfile, SubagentToolDetails, SubagentUsage } from "../types.ts";
import type { WorkflowAgentResultEvent, WorkflowAgentRunner } from "./types.ts";
import { createStructuredOutputTool, STRUCTURED_OUTPUT_CONTRACT, WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE, type StructuredOutputCapture } from "./structured-output.ts";

export interface WorkflowAgentRunnerOptions {
  profiles: Map<string, SubagentProfile>;
  ctx: ExtensionContext;
  thinkingLevel?: string;
  timeoutMs: number;
  allowedBackends?: readonly SubagentBackend[];
  onUsage?: (index: number, usage: SubagentUsage) => void;
  onProgress?: (index: number, details: SubagentToolDetails) => void;
  toolCallId?: string;
}

/** Canonical profile-aware runner shared by the interactive tool and headless API. */
export function createWorkflowAgentRunner(options: WorkflowAgentRunnerOptions): {
  runAgent: WorkflowAgentRunner;
  serializeAgent: <T>(sessionKey: string | undefined, task: () => Promise<T>) => Promise<T>;
  restoreSessionBinding: (event: WorkflowAgentResultEvent) => void;
} {
  const bindings = new Map<string, SessionKeyBinding>();
  const locks = new SessionKeyLocks();
  let sequence = 0;
  const allowed = options.allowedBackends ? new Set(options.allowedBackends) : undefined;

  const runAgent: WorkflowAgentRunner = async (call, signal) => {
    const profile = options.profiles.get(call.subagentType);
    if (!profile) throw new Error(`Unknown subagent_type "${call.subagentType}".`);
    if (allowed && !allowed.has(profile.backend)) throw new Error(`Backend "${profile.backend}" is not allowed.`);
    const model = resolveProfileModel(profile, options.ctx);
    if (usesPiBackend(profile) && !model) throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");

    let capture: StructuredOutputCapture | undefined;
    let customTools: ToolDefinition[] | undefined;
    const externalSchema = !usesPiBackend(profile) && call.schema != null;
    let appendInstructions = WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE;
    if (call.schema != null && !externalSchema) {
      capture = { value: undefined, called: false, count: 0, duplicateCall: false };
      customTools = [createStructuredOutputTool(call.schema, capture)];
      appendInstructions = STRUCTURED_OUTPUT_CONTRACT;
    } else if (externalSchema) {
      appendInstructions = `${WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE}\nStructured output contract:\n- Return only JSON matching the schema supplied to the CLI. No markdown fences or prose.`;
    }

    const index = call.index ?? ++sequence;
    const binding = call.sessionKey ? bindings.get(call.sessionKey) : undefined;
    if (binding) assertBindingMatchesProfile(binding, { subagentType: call.subagentType, backend: profile.backend });
    call.backend = profile.backend;
    call.sessionId = binding?.sessionId;
    const result = await spawnSubagent({
      toolCallId: `${options.toolCallId ?? "headless"}:agent:${index}`,
      description: call.label,
      prompt: call.prompt,
      profile,
      model,
      thinkingLevel: profile.thinking ?? options.thinkingLevel,
      ctx: options.ctx,
      signal,
      timeoutMs: options.timeoutMs,
      progressEnabled: Boolean(options.onProgress),
      onProgress: (partial) => options.onProgress?.(index, partial.details as SubagentToolDetails),
      onUsage: (usage) => options.onUsage?.(index, usage),
      excludeTools: CHILD_EXCLUDED_TOOLS,
      appendInstructions,
      customTools,
      sessionId: binding?.sessionId,
      persistSession: Boolean(call.sessionKey),
      outputSchema: externalSchema ? call.schema : undefined,
    });
    const details = result.details as SubagentToolDetails;
    options.onProgress?.(index, details);
    if (call.sessionKey && details.sessionId) {
      call.sessionId = details.sessionId;
      bindings.set(call.sessionKey, { key: call.sessionKey, sessionId: details.sessionId, subagentType: call.subagentType, backend: profile.backend });
    }
    if (details.status !== "done") throw new Error(details.error ?? "subagent failed");
    if (externalSchema) {
      try { return JSON.parse(details.result ?? "null"); } catch { throw new Error("external subagent structured output was not valid JSON"); }
    }
    if (capture) {
      if (!capture.called) throw new Error("subagent finished without calling structured_output");
      return capture.value;
    }
    return details.result ?? "";
  };

  const restoreSessionBinding = (event: WorkflowAgentResultEvent) => {
    if (
      !event.sessionKey ||
      !event.sessionId ||
      (event.backend !== "pi" && event.backend !== "codex" && event.backend !== "claude")
    ) return;
    const binding: SessionKeyBinding = {
      key: event.sessionKey,
      sessionId: event.sessionId,
      subagentType: event.subagentType,
      backend: event.backend,
    };
    const existing = bindings.get(event.sessionKey);
    if (existing) assertBindingMatchesProfile(existing, binding);
    bindings.set(event.sessionKey, binding);
  };

  return { runAgent, serializeAgent: (key, task) => locks.run(key, task), restoreSessionBinding };
}
