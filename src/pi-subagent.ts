import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { buildCoordinatorPrompt, getPresetAppendPrompt, PRESET_DESCRIPTIONS } from "./prompts.ts";
import type { SubagentExtensionOptions, SubagentToolDetails, SubagentType } from "./types.ts";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_WIDTH = 4;
const ALLOWED_SUBAGENTS: SubagentType[] = ["general-purpose", "explorer"];

const agentToolParameters = Type.Object({
  description: Type.String({
    description: "A short 3-5 word description of the task, used for UI display and routing context.",
  }),
  prompt: Type.String({
    description: "The self-contained task briefing to send to the subagent.",
  }),
  subagent_type: Type.Optional(
    Type.String({
      description: `The preset subagent to use. Allowed values: ${ALLOWED_SUBAGENTS.join(", ")}. Defaults to general-purpose.`,
    }),
  ),
});

type AgentToolParams = Static<typeof agentToolParameters>;

interface DelegationState {
  depth: number;
  maxDepth: number;
  maxWidth: number;
  childCount: number;
}

interface CreateAgentToolOptions {
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

function normalizeLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeSubagentType(value: string | undefined): SubagentType | undefined {
  if (value === undefined || value.trim() === "") {
    return "general-purpose";
  }
  return ALLOWED_SUBAGENTS.includes(value as SubagentType) ? (value as SubagentType) : undefined;
}

function textResult(text: string, details: SubagentToolDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function extractFinalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const textParts = message.content
      .map((part) => {
        const block = part as { type?: string; text?: unknown };
        return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (textParts.length > 0) {
      return textParts.join("\n").trim();
    }
  }
  return "";
}

async function runSubagent(
  params: AgentToolParams,
  subagentType: SubagentType,
  state: DelegationState,
  options: CreateAgentToolOptions,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ReturnType<typeof textResult>> {
  if (!ctx.model) {
    return textResult("Cannot launch subagent: no model is selected.", {
      description: params.description,
      subagentType,
      depth: state.depth + 1,
      status: "rejected",
      error: "No model is selected",
    });
  }

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    getPresetAppendPrompt(subagentType),
    buildCoordinatorPrompt(state.maxDepth, state.maxWidth),
  ].filter((prompt): prompt is string => Boolean(prompt));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: appendPrompts,
  });
  await resourceLoader.reload();

  const childState: DelegationState = {
    depth: state.depth + 1,
    maxDepth: state.maxDepth,
    maxWidth: state.maxWidth,
    childCount: 0,
  };

  const nestedAgentTool = createAgentTool(childState, options);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: ctx.model,
    thinkingLevel: options.getThinkingLevel(),
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    customTools: [nestedAgentTool as ToolDefinition],
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      void session.abort();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await session.bindExtensions({});
    await session.prompt(params.prompt, { source: "extension" });
    const result = extractFinalAssistantText(session.messages) || "(no final text output)";
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      depth: childState.depth,
      status: "completed",
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Subagent "${params.description}" (${subagentType}) failed: ${message}`, {
      description: params.description,
      subagentType,
      depth: childState.depth,
      status: "error",
      error: message,
    });
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}

function createAgentTool(
  state: DelegationState,
  options: CreateAgentToolOptions,
): ToolDefinition<typeof agentToolParameters, SubagentToolDetails> {
  return defineTool({
    name: "Agent",
    label: "Agent",
    description: `Launch a fresh foreground subagent. Available preset subagents: ${ALLOWED_SUBAGENTS.join(", ")}.

Use this tool for independent work that matches a preset, spans several files, fans out into separate workstreams, or would otherwise fill your context with large search output. Default to Agent for repo/branch ship-readiness audits, cross-repo comparisons, independent checklist searches, and second opinions on risky migrations or security-sensitive paths.

Subagents start with fresh conversation history, so prompts must be self-contained.`,
    promptSnippet: "Launch a fresh foreground subagent for scoped work.",
    promptGuidelines: [
      "Use Agent for independent multi-file exploration or scoped work that should not fill the main context.",
      "Default to Agent for broad repo audits, cross-repo comparisons, independent checklist searches, and second opinions on risky migrations.",
      "Subagent prompts must be self-contained because subagents start with fresh conversation history.",
      "After Agent returns, relay the important findings to the user; the user does not see the tool result directly.",
    ],
    parameters: agentToolParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const subagentType = normalizeSubagentType(params.subagent_type);
      if (!subagentType) {
        return textResult(
          `Unknown subagent_type "${params.subagent_type}". Allowed values: ${ALLOWED_SUBAGENTS.join(", ")}.`,
          {
            description: params.description,
            subagentType: "unknown",
            depth: state.depth + 1,
            status: "rejected",
            error: "Unknown subagent_type",
          },
        );
      }

      if (state.depth >= state.maxDepth) {
        return textResult(
          `Maximum subagent depth reached. Current depth: ${state.depth}; maxDepth: ${state.maxDepth}.`,
          {
            description: params.description,
            subagentType,
            depth: state.depth + 1,
            status: "rejected",
            error: "Maximum subagent depth reached",
          },
        );
      }

      if (state.childCount >= state.maxWidth) {
        return textResult(
          `Maximum subagent width reached for this agent run. maxWidth: ${state.maxWidth}.`,
          {
            description: params.description,
            subagentType,
            depth: state.depth + 1,
            status: "rejected",
            error: "Maximum subagent width reached",
          },
        );
      }

      state.childCount++;
      onUpdate?.(textResult(`Subagent "${params.description}" (${subagentType}) is running.`, {
        description: params.description,
        subagentType,
        depth: state.depth + 1,
        status: "running",
      }));
      return runSubagent(params, subagentType, state, options, signal, ctx);
    },
    renderCall(args, theme) {
      const subagentType = normalizeSubagentType(args.subagent_type) ?? "unknown";
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", subagentType)} ${theme.fg("dim", args.description)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      const status = details.status === "completed" ? "completed" : details.status;
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", details.subagentType)} ${theme.fg("dim", details.description)} ${theme.fg("dim", status)}`,
        0,
        0,
      );
    },
  });
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
  const maxDepth = normalizeLimit(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth");
  const maxWidth = normalizeLimit(options.maxWidth, DEFAULT_MAX_WIDTH, "maxWidth");

  return function subagentExtension(pi: ExtensionAPI) {
    const rootState: DelegationState = {
      depth: 0,
      maxDepth,
      maxWidth,
      childCount: 0,
    };
    const toolOptions: CreateAgentToolOptions = {
      getThinkingLevel: () => pi.getThinkingLevel(),
    };

    pi.registerTool(createAgentTool(rootState, toolOptions));

    pi.on("before_agent_start", (event) => {
      rootState.childCount = 0;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildCoordinatorPrompt(maxDepth, maxWidth)}`,
      };
    });
  };
}

export default createSubagentExtension();
