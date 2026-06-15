import { defineTool, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export interface StructuredOutputCapture<T = unknown> {
  value: T | undefined;
  called: boolean;
}

export const STRUCTURED_OUTPUT_CONTRACT = [
  "Final output contract:",
  "- Your final action MUST be a single structured_output tool call.",
  "- The structured_output arguments ARE this subagent's return value.",
  "- Do not write a prose final answer instead of calling structured_output.",
  "- Inspect files or run commands first if needed, then call structured_output exactly once.",
  "- If schema validation fails, read the error and call structured_output again with a corrected shape.",
  "- After calling structured_output successfully, end your turn — no acknowledgment needed.",
].join("\n");

/**
 * Appended to a schema-less workflow subagent's task so it knows its final text
 * is the script's verbatim return value, not a message to a person.
 */
export const WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE = [
  "Output contract:",
  "- Your final text response is returned verbatim to the calling workflow script — it is your return value, not a message to a person.",
  "- Output the literal result (data, JSON, or text). Do not add confirmations like \"Done\" or conversational framing.",
  "- If asked for JSON, return only the raw JSON — no code fences, no prose.",
  "- Be concise; the script parses your output.",
].join("\n");

/**
 * A terminating output tool: pi validates the model's call against `schema`, and
 * the validated arguments become the subagent's structured result (captured into
 * `capture`). pinned pi (0.79.4) has no `terminate` flag, so the prompt contract
 * (STRUCTURED_OUTPUT_CONTRACT) is what stops the subagent after a single call.
 */
export function createStructuredOutputTool(
  schema: unknown,
  capture: StructuredOutputCapture,
): ToolDefinition<TSchema, unknown> {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: "Return the final machine-readable result for this subagent task. Call exactly once when done.",
    promptSnippet: "Return final machine-readable output",
    promptGuidelines: [
      "structured_output is the final answer channel for this task; call it exactly once when done.",
      "Do not write a prose final answer after calling structured_output.",
    ],
    parameters: schema as TSchema,
    async execute(_toolCallId, params) {
      capture.value = params;
      capture.called = true;
      return {
        content: [{ type: "text" as const, text: "Structured output received." }],
        details: params,
      };
    },
  });
}

/** Wrap a tool definition as an extension factory so it can be injected into a child session. */
export function toolExtensionFactory(tool: ToolDefinition<TSchema, unknown>): ExtensionFactory {
  return (pi) => {
    pi.registerTool(tool);
  };
}
