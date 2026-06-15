import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";
import { filterProfilesForModelRegistry, resolveProfileModel } from "../core/model.ts";
import { spawnSubagent } from "../core/spawn.ts";
import { getSubagentProfiles } from "../profiles.ts";
import { WORKFLOW_PROMPT_GUIDELINES, WORKFLOW_PROMPT_SNIPPET } from "../prompts.ts";
import type { SubagentUsage, WorkflowAgentSnapshot, WorkflowToolDetails } from "../types.ts";
import { parseWorkflowScript, runWorkflow, type WorkflowAgentRunner } from "./runtime.ts";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_CONTRACT,
  WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE,
  type StructuredOutputCapture,
} from "./structured-output.ts";

const workflowToolParameters = Type.Object({
  script: Type.String({
    description: [
      "Raw JavaScript workflow script (no Markdown fences).",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty' }.",
      "Use agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Must call agent() at least once.",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the script as the global `args`." }),
  ),
});

type WorkflowToolParams = Static<typeof workflowToolParameters>;

export interface CreateWorkflowToolOptions {
  limiter: ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
}

function workflowResult(text: string, details: WorkflowToolDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function cloneSnapshot(snapshot: WorkflowToolDetails): WorkflowToolDetails {
  return {
    ...snapshot,
    phases: [...snapshot.phases],
    agents: snapshot.agents.map((agent) => ({ ...agent })),
    logs: [...snapshot.logs],
  };
}

function isAbortMessage(message: string): boolean {
  return /\babort(?:ed)?\b/i.test(message);
}

export function createWorkflowTool(
  options: CreateWorkflowToolOptions,
): ToolDefinition<typeof workflowToolParameters, WorkflowToolDetails> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline(), then synthesizes their results. `script` is required raw JavaScript starting with `export const meta = { name, description }` and must call agent() at least once.",
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: workflowToolParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);

      // Parse up front: surfaces meta + script errors before any subagent runs.
      let metaName = "workflow";
      try {
        metaName = parseWorkflowScript(script).meta.name;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return workflowResult(`Workflow script is invalid: ${message}`, {
          name: metaName,
          status: "error",
          agentCount: 0,
          phases: [],
          agents: [],
          logs: [],
          error: message,
        });
      }

      const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      let agentSeq = 0;
      const runAgent: WorkflowAgentRunner = async (call, agentSignal) => {
        const profile = profiles.get(call.subagentType);
        if (!profile) {
          throw new Error(
            `Unknown subagent_type "${call.subagentType}". Available agents: ${[...profiles.keys()].join(", ")}.`,
          );
        }
        const model = resolveProfileModel(profile, ctx);
        if (!model) {
          throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");
        }

        // Structured output: inject a schema-validated structured_output tool and
        // require the subagent to end with it. The captured args become the result.
        let capture: StructuredOutputCapture | undefined;
        let customTools: ToolDefinition[] | undefined;
        let appendInstructions: string;
        if (call.schema !== undefined && call.schema !== null) {
          capture = { value: undefined, called: false };
          customTools = [createStructuredOutputTool(call.schema, capture)];
          appendInstructions = STRUCTURED_OUTPUT_CONTRACT;
        } else {
          appendInstructions = WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE;
        }

        const childId = `${toolCallId}:agent:${++agentSeq}`;
        const result = await spawnSubagent({
          toolCallId: childId,
          description: call.label,
          prompt: call.prompt,
          profile,
          model,
          thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
          ctx,
          signal: agentSignal,
          progressEnabled: false,
          onProgress: undefined,
          onUsage: (usage) => options.updateStatus(ctx, childId, usage),
          excludeTools: ["Agent", "workflow"],
          appendInstructions,
          customTools,
        });
        if (result.details.status !== "completed") {
          throw new Error(result.details.error ?? "subagent failed");
        }
        if (capture) {
          if (!capture.called) {
            throw new Error("subagent finished without calling structured_output");
          }
          return capture.value;
        }
        return result.details.result ?? "";
      };

      const snapshot: WorkflowToolDetails = {
        name: metaName,
        status: "running",
        agentCount: 0,
        phases: [],
        agents: [],
        logs: [],
      };
      const emit = () => onUpdate?.(workflowResult(`Workflow "${metaName}" running.`, cloneSnapshot(snapshot)));

      try {
        const runResult = await runWorkflow(script, {
          args: params.args,
          cwd: ctx.cwd,
          signal,
          limiter: options.limiter,
          runAgent,
          onLog: (message) => {
            snapshot.logs.push(message);
            emit();
          },
          onPhase: (title) => {
            if (!snapshot.phases.includes(title)) {
              snapshot.phases.push(title);
            }
            emit();
          },
          onAgentStart: (event) => {
            snapshot.agents.push({ label: event.label, phase: event.phase, status: "running" });
            snapshot.agentCount = snapshot.agents.length;
            emit();
          },
          onAgentEnd: (event) => {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
            }
            emit();
          },
        });

        snapshot.status = "completed";
        snapshot.agentCount = runResult.agentCount;
        snapshot.result = runResult.result;
        const resultText = JSON.stringify(runResult.result, null, 2);
        return workflowResult(
          `Workflow "${runResult.meta.name}" completed with ${runResult.agentCount} agent(s).\n\nResult:\n${resultText}`,
          cloneSnapshot(snapshot),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = Boolean(signal?.aborted) || isAbortMessage(message);
        snapshot.status = aborted ? "aborted" : "error";
        snapshot.error = message;
        for (const agent of snapshot.agents) {
          if (agent.status === "running") {
            agent.status = "error";
          }
        }
        return workflowResult(
          `Workflow "${metaName}" ${aborted ? "aborted" : "failed"}: ${message}`,
          cloneSnapshot(snapshot),
        );
      }
    },
    renderCall(_args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      return new Text(`${theme.bold("Workflow")}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WorkflowToolDetails;
      return renderWorkflowSnapshot(details, theme);
    },
  });
}

function formatAgentStatus(agent: WorkflowAgentSnapshot): string {
  const mark = agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : "•";
  const phase = agent.phase ? `${agent.phase} / ` : "";
  return `${mark} ${phase}${agent.label}`;
}

function renderWorkflowSnapshot(details: WorkflowToolDetails, theme: Theme): Container {
  const container = new Container();
  const done = details.agents.filter((agent) => agent.status === "done").length;
  const failed = details.agents.filter((agent) => agent.status === "error").length;
  const counts = `${done}/${details.agents.length} done${failed ? `, ${failed} failed` : ""}`;
  container.addChild(
    new Text(
      `${theme.bold(`Workflow(${details.name})`)} ${theme.fg("dim", `${details.status} · ${counts}`)}`,
      0,
      0,
    ),
  );

  for (const agent of details.agents.slice(-6)) {
    const color = agent.status === "error" ? "error" : "muted";
    container.addChild(new Text(`  ${theme.fg(color, formatAgentStatus(agent))}`, 0, 0));
  }

  if (details.error) {
    container.addChild(new Text(`  ${theme.fg("error", details.error)}`, 0, 0));
  }

  return container;
}

function normalizeWorkflowScript(script: string): string {
  let text = typeof script === "string" ? script.trim() : "";
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) {
    text = fence[1].trim();
  }
  return text;
}
