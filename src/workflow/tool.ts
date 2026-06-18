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
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../core/spawn.ts";
import { getSubagentProfiles } from "../profiles.ts";
import { WORKFLOW_PROMPT_GUIDELINES, WORKFLOW_PROMPT_SNIPPET } from "../prompts.ts";
import type { SubagentUsage, WorkflowAgentSnapshot, WorkflowToolDetails } from "../types.ts";
import {
  createWorkflowJournalWriter,
  createWorkflowRunIdentity,
  getSessionWorkflowDir,
  loadWorkflowJournal,
  persistWorkflowScript,
  type WorkflowJournalWriter,
} from "./journal.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "./registry.ts";
import {
  isWorkflowAbortError,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentRunner,
  type WorkflowCachedAgentResult,
} from "./runtime.ts";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_CONTRACT,
  WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE,
  type StructuredOutputCapture,
} from "./structured-output.ts";

const workflowToolParameters = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script (no Markdown fences) for an ad-hoc workflow.",
        "First statement: export const meta = { name: 'short_name', description: 'non-empty' }.",
        "Use agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Must call agent() at least once and return a JSON-serializable value. Results are canonicalized to JSON; non-plain objects are rejected.",
        "Provide exactly one of `script`, `name`, or `scriptPath`."
      ].join(" "),
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Name of a saved workflow from ~/.pi/agent/workflows or trusted .pi/workflows. Provide exactly one of `script`, `name`, or `scriptPath`.",
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Path to a saved or session-persisted workflow script. The path must resolve inside an allowed workflow root. Provide exactly one of `script`, `name`, or `scriptPath`.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the script as the global `args`." }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description:
        "Optional previous workflow run id to resume from. Only valid when `scriptPath` is the workflow source. Cached agent results are reused for the longest unchanged prefix of agent() calls.",
    }),
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

/** Build an early-return error result, filling the fixed error-snapshot fields. */
function workflowError(
  text: string,
  details: Partial<WorkflowToolDetails> & { name: string; error: string },
) {
  return workflowResult(text, {
    status: "error",
    agentCount: 0,
    phases: [],
    agents: [],
    logs: [],
    ...details,
  });
}

function cloneSnapshot(snapshot: WorkflowToolDetails): WorkflowToolDetails {
  return {
    ...snapshot,
    phases: [...snapshot.phases],
    agents: snapshot.agents.map((agent) => ({ ...agent })),
    logs: [...snapshot.logs],
  };
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function formatAvailableWorkflowNames(names: string[]): string {
  return names.length ? names.join(", ") : "none";
}

function formatWarnings(warnings: string[]): string {
  if (!warnings.length) {
    return "";
  }
  return `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function formatRecentLogs(logs: string[], max = 10): string {
  if (!logs.length) {
    return "";
  }
  const shown = logs.slice(-max);
  const hidden = logs.length - shown.length;
  const prefix = hidden > 0 ? `- ... ${hidden} earlier log(s)\n` : "";
  return `\n\nLogs:\n${prefix}${shown.map((log) => `- ${log}`).join("\n")}`;
}

type WorkflowSource =
  | {
      ok: true;
      script: string;
      source: "inline" | "saved" | "path";
      sourcePath?: string;
      requestedName?: string;
      warnings: string[];
    }
  | { ok: false; message: string; warnings: string[] };

function resolveWorkflowSource(params: WorkflowToolParams, ctx: ExtensionContext): WorkflowSource {
  const inlineScript = typeof params.script === "string" && params.script.trim() ? params.script : undefined;
  const savedName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
  const scriptPath = typeof params.scriptPath === "string" && params.scriptPath.trim() ? params.scriptPath.trim() : undefined;
  const sourceCount = Number(Boolean(inlineScript)) + Number(Boolean(savedName)) + Number(Boolean(scriptPath));
  if (sourceCount !== 1) {
    return {
      ok: false,
      message:
        "Workflow requires exactly one non-empty source: `script` for an ad-hoc workflow, `name` for a saved workflow, or `scriptPath` for a persisted script.",
      warnings: [],
    };
  }
  if (inlineScript) {
    return { ok: true, script: inlineScript, source: "inline", warnings: [] };
  }

  const sessionWorkflowDir = getSessionWorkflowDir(ctx);
  const projectTrusted = isProjectTrusted(ctx);
  if (scriptPath) {
    const result = loadWorkflowScriptPath(scriptPath, {
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted,
      sessionWorkflowDir,
    });
    if (!result.ok) {
      return { ok: false, message: result.message, warnings: result.warnings };
    }
    return {
      ok: true,
      script: result.workflow.script,
      source: "path",
      sourcePath: result.workflow.path,
      requestedName: result.workflow.meta.name,
      warnings: result.warnings,
    };
  }

  const registry = loadSavedWorkflowRegistry({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    projectTrusted,
  });
  const workflow = registry.workflows.get(savedName ?? "");
  if (!workflow) {
    return {
      ok: false,
      message: `Unknown saved workflow "${savedName}". Available workflows: ${formatAvailableWorkflowNames([
        ...registry.workflows.keys(),
      ].sort())}.`,
      warnings: registry.warnings,
    };
  }
  return {
    ok: true,
    script: workflow.script,
    source: "saved",
    sourcePath: workflow.path,
    requestedName: savedName,
    warnings: registry.warnings,
  };
}

export function createWorkflowTool(
  options: CreateWorkflowToolOptions,
): ToolDefinition<typeof workflowToolParameters, WorkflowToolDetails> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a saved, session-persisted, or ad-hoc trusted JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline(), then synthesizes their results. Provide exactly one of `name` (saved workflow), `scriptPath` (persisted script), or `script` (raw JavaScript starting with `export const meta = { name, description }`). Use `resumeFromRunId` with `scriptPath` to reuse cached agent results for the longest unchanged prefix. Every workflow must call agent() at least once.",
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: workflowToolParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const source = resolveWorkflowSource(params, ctx);
      if (!source.ok) {
        return workflowError(`${source.message}${formatWarnings(source.warnings)}`, {
          name: "workflow",
          error: source.message,
          logs: source.warnings,
        });
      }

      const script = normalizeWorkflowScript(source.script);

      // Parse up front: surfaces meta + script errors before any subagent runs.
      let metaName = source.requestedName ?? "workflow";
      try {
        metaName = parseWorkflowScript(script).meta.name;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return workflowError(`Workflow script is invalid: ${message}`, {
          name: metaName,
          error: message,
          logs: source.warnings,
          source: source.source,
          sourcePath: source.sourcePath,
          scriptPath: source.sourcePath,
        });
      }

      const resumeFromRunId = typeof params.resumeFromRunId === "string" && params.resumeFromRunId.trim()
        ? params.resumeFromRunId.trim()
        : undefined;
      if (resumeFromRunId && source.source !== "path") {
        const message = "Cannot resume workflow: resumeFromRunId can only be used with scriptPath.";
        return workflowError(message, {
          name: metaName,
          error: message,
          logs: source.warnings,
          source: source.source,
          sourcePath: source.sourcePath,
          scriptPath: undefined,
          resumeFromRunId,
        });
      }

      const sessionWorkflowDir = getSessionWorkflowDir(ctx);
      const identity = createWorkflowRunIdentity(script, params.args);
      let scriptPath = source.sourcePath;
      if (source.source === "inline" && sessionWorkflowDir) {
        try {
          scriptPath = await persistWorkflowScript({
            dir: sessionWorkflowDir,
            metaName,
            scriptHash: identity.scriptHash,
            script,
          });
        } catch (error) {
          const message = `Workflow persistence failed: ${error instanceof Error ? error.message : String(error)}`;
          return workflowError(message, {
            name: metaName,
            error: message,
            logs: source.warnings,
            source: source.source,
            sourcePath: source.sourcePath,
            runId: identity.runId,
          });
        }
      }

      let resumeAgentResults: WorkflowCachedAgentResult[] | undefined = undefined;
      if (resumeFromRunId) {
        if (!sessionWorkflowDir) {
          const message = "Cannot resume workflow: current session has no persisted workflow state.";
          return workflowError(message, {
            name: metaName,
            error: message,
            logs: source.warnings,
            source: source.source,
            sourcePath: source.sourcePath,
            scriptPath,
            runId: identity.runId,
            resumeFromRunId,
          });
        }
        let journal;
        try {
          journal = await loadWorkflowJournal(sessionWorkflowDir, resumeFromRunId);
        } catch (error) {
          const message = `Cannot resume workflow: ${error instanceof Error ? error.message : String(error)}`;
          return workflowError(message, {
            name: metaName,
            error: message,
            logs: source.warnings,
            source: source.source,
            sourcePath: source.sourcePath,
            scriptPath,
            runId: identity.runId,
            resumeFromRunId,
          });
        }
        if (!journal) {
          const message = `Cannot resume workflow: run journal not found for ${resumeFromRunId}.`;
          return workflowError(message, {
            name: metaName,
            error: message,
            logs: source.warnings,
            source: source.source,
            sourcePath: source.sourcePath,
            scriptPath,
            runId: identity.runId,
            resumeFromRunId,
          });
        }
        resumeAgentResults = journal.agentResults;
      }

      let journalWriter: WorkflowJournalWriter | undefined;
      if (sessionWorkflowDir) {
        try {
          journalWriter = await createWorkflowJournalWriter({
            dir: sessionWorkflowDir,
            identity,
            name: metaName,
            source: source.source,
            scriptPath,
            resumeFromRunId,
          });
        } catch (error) {
          const message = `Workflow journal setup failed: ${error instanceof Error ? error.message : String(error)}`;
          return workflowError(message, {
            name: metaName,
            error: message,
            logs: source.warnings,
            source: source.source,
            sourcePath: source.sourcePath,
            scriptPath,
            runId: identity.runId,
            resumeFromRunId,
          });
        }
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
          capture = { value: undefined, called: false, count: 0, duplicateCall: false };
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
          excludeTools: CHILD_EXCLUDED_TOOLS,
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
        logs: [...source.warnings],
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        runId: identity.runId,
        journalPath: journalWriter?.path,
        resumeFromRunId,
        cachedAgentCount: 0,
      };
      const emit = () => onUpdate?.(workflowResult(`Workflow "${metaName}" running.`, cloneSnapshot(snapshot)));

      try {
        const runResult = await runWorkflow(script, {
          args: params.args,
          cwd: ctx.cwd,
          signal,
          limiter: options.limiter,
          runAgent,
          resumeAgentResults,
          onLog: (message) => {
            snapshot.logs.push(message);
            emit();
          },
          onPhase: (title) => {
            if (!snapshot.phases.includes(title)) {
              snapshot.phases.push(title);
            }
            snapshot.currentPhase = title;
            emit();
          },
          onAgentStart: (event) => {
            snapshot.agents.push({ index: event.index, label: event.label, phase: event.phase, status: event.cached ? "done" : "running" });
            snapshot.agentCount = snapshot.agents.length;
            if (event.cached) {
              snapshot.cachedAgentCount = (snapshot.cachedAgentCount ?? 0) + 1;
            }
            emit();
          },
          onAgentEnd: (event) => {
            const agent = snapshot.agents.find((item) => item.index === event.index);
            if (agent) {
              agent.status = event.failed ? "error" : "done";
            }
            emit();
          },
          onAgentResult: async (event) => {
            await journalWriter?.appendAgentResult(event);
          },
        });

        snapshot.status = "completed";
        snapshot.agentCount = runResult.agentCount;
        snapshot.result = runResult.result;
        try {
          await journalWriter?.complete(runResult.result);
        } catch (error) {
          snapshot.logs.push(`workflow journal completion failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const resultText = JSON.stringify(runResult.result, null, 2);
        const cachedText = snapshot.cachedAgentCount ? ` (${snapshot.cachedAgentCount} cached)` : "";
        const scriptPathText = snapshot.scriptPath ? `\nscriptPath: ${snapshot.scriptPath}` : "";
        const runIdText = snapshot.runId ? `\nrunId: ${snapshot.runId}` : "";
        return workflowResult(
          `Workflow "${runResult.meta.name}" completed with ${runResult.agentCount} agent(s)${cachedText}.${scriptPathText}${runIdText}${formatWarnings(source.warnings)}${formatRecentLogs(snapshot.logs)}\n\nResult:\n${resultText}`,
          cloneSnapshot(snapshot),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = Boolean(signal?.aborted) || isWorkflowAbortError(error);
        snapshot.status = aborted ? "aborted" : "error";
        snapshot.error = message;
        try {
          await journalWriter?.fail(message);
        } catch {
          // Preserve the original workflow failure; journal write failure is secondary.
        }
        for (const agent of snapshot.agents) {
          if (agent.status === "running") {
            agent.status = "error";
          }
        }
        return workflowResult(
          `Workflow "${metaName}" ${aborted ? "aborted" : "failed"}: ${message}${formatRecentLogs(snapshot.logs)}`,
          cloneSnapshot(snapshot),
        );
      }
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const name = typeof args.name === "string" && args.name.trim() ? ` ${theme.fg("muted", args.name.trim())}` : "";
      return new Text(`${theme.bold("Workflow")}${name}`, 0, 0);
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

function agentIcon(status: WorkflowAgentSnapshot["status"]): string {
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  return "●";
}

function agentRenderPriority(agent: WorkflowAgentSnapshot): number {
  if (agent.status === "error") return 0;
  if (agent.status === "running") return 1;
  return 2;
}

function selectAgentsForRender(agents: WorkflowAgentSnapshot[], max = 6): WorkflowAgentSnapshot[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => agentRenderPriority(a.agent) - agentRenderPriority(b.agent) || b.index - a.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.agent);
}

// Ordered list of phase groups: entered phases first, in entry order, then any
// agent-only phases, then an `undefined` bucket for unphased agents. Entered
// phases are kept even before their first agent starts so live phase() updates
// stay visible. Layout inspired by Michaelliv/pi-dynamic-workflows.
function orderedPhases(details: WorkflowToolDetails): (string | undefined)[] {
  const seen = new Set<string>();
  const order: (string | undefined)[] = [];
  for (const phase of details.phases) {
    if (!seen.has(phase)) {
      seen.add(phase);
      order.push(phase);
    }
  }
  for (const agent of details.agents) {
    if (agent.phase && !seen.has(agent.phase)) {
      seen.add(agent.phase);
      order.push(agent.phase);
    }
  }
  if (details.agents.some((agent) => !agent.phase)) order.push(undefined);
  return order;
}

function renderPhaseTree(container: Container, details: WorkflowToolDetails, theme: Theme): void {
  for (const phase of orderedPhases(details)) {
    const agents = details.agents.filter((agent) => agent.phase === phase);
    const pDone = agents.filter((agent) => agent.status === "done").length;
    const pErr = agents.filter((agent) => agent.status === "error").length;
    const pRun = agents.filter((agent) => agent.status === "running").length;
    const complete = agents.length > 0 && pDone + pErr === agents.length;
    const isCurrent = phase !== undefined && details.currentPhase === phase;
    const marker = complete ? "✓" : pRun > 0 || isCurrent ? "▶" : "·";
    const extra = `${pRun ? ` · ${pRun} running` : ""}${pErr ? ` · ${pErr} failed` : ""}`;
    container.addChild(
      new Text(
        `  ${theme.fg(pErr ? "error" : "muted", `${marker} ${phase ?? "unphased"} ${pDone}/${agents.length}${extra}`)}`,
        0,
        0,
      ),
    );
    const shown = selectAgentsForRender(agents);
    for (const agent of shown) {
      const color = agent.status === "error" ? "error" : "muted";
      container.addChild(
        new Text(`    ${theme.fg(color, `#${agent.index} ${agentIcon(agent.status)} ${agent.label}`)}`, 0, 0),
      );
    }
    const hidden = agents.length - shown.length;
    if (hidden > 0) {
      container.addChild(new Text(`    ${theme.fg("muted", `... ${hidden} more`)}`, 0, 0));
    }
  }
}

function renderFlatAgents(container: Container, details: WorkflowToolDetails, theme: Theme): void {
  const renderedAgents = selectAgentsForRender(details.agents);
  const hiddenAgents = details.agents.length - renderedAgents.length;
  if (hiddenAgents > 0) {
    container.addChild(new Text(`  ${theme.fg("muted", `... ${hiddenAgents} agent(s) not shown`)}`, 0, 0));
  }
  for (const agent of renderedAgents) {
    const color = agent.status === "error" ? "error" : "muted";
    container.addChild(new Text(`  ${theme.fg(color, formatAgentStatus(agent))}`, 0, 0));
  }
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

  // Phase-grouped tree when the workflow uses phase() (including before the first
  // agent in a phase starts); otherwise keep the flat list.
  if (details.phases.length > 0 || details.agents.some((agent) => agent.phase)) {
    renderPhaseTree(container, details, theme);
  } else {
    renderFlatAgents(container, details, theme);
  }

  for (const line of details.logs.slice(-3)) {
    container.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
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
