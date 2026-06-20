import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";
import { isActiveSubagentStatus, isCompletedSubagentStatus, renderSubagentNode } from "../core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "../core/spinner.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "../core/model.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../core/spawn.ts";
import { getSubagentProfiles } from "../profiles.ts";
import { WORKFLOW_PROMPT_GUIDELINES, WORKFLOW_PROMPT_SNIPPET } from "../prompts.ts";
import type { SubagentToolDetails, SubagentUsage, WorkflowAgentSnapshot, WorkflowToolDetails } from "../types.ts";
import { isWorkflowAbortError, runWorkflow } from "./runtime.ts";
import { prepareWorkflowToolSource, workflowToolParameters } from "./source.ts";
import type { WorkflowAgentRunner } from "./types.ts";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_CONTRACT,
  WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE,
  type StructuredOutputCapture,
} from "./structured-output.ts";

export interface CreateWorkflowToolOptions {
  getLimiter: () => ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
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
    plannedPhases: snapshot.plannedPhases?.map((phase) => ({ ...phase })),
    agents: snapshot.agents.map((agent) => ({ ...agent, activity: agent.activity ? [...agent.activity] : undefined })),
    logs: [...snapshot.logs],
  };
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
      const prepared = await prepareWorkflowToolSource(params, ctx);
      if (!prepared.ok) {
        return workflowError(prepared.text, prepared.details);
      }

      const {
        script,
        metaName,
        plannedPhases,
        source,
        sourcePath,
        scriptPath,
        warnings,
        identity,
        journalWriter,
        resumeFromRunId,
        resumeAgentResults,
      } = prepared.value;

      const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const snapshot: WorkflowToolDetails = {
        name: metaName,
        status: "running",
        agentCount: 0,
        phases: [],
        plannedPhases,
        agents: [],
        logs: [...warnings],
        source,
        sourcePath,
        scriptPath,
        runId: identity.runId,
        journalPath: journalWriter?.path,
        resumeFromRunId,
        cachedAgentCount: 0,
      };
      const emit = () => onUpdate?.(workflowResult(`Workflow "${metaName}" running.`, cloneSnapshot(snapshot)));

      let agentSeq = 0;
      const runAgent: WorkflowAgentRunner = async (call, agentSignal) => {
        const profile = profiles.get(call.subagentType);
        if (!profile) {
          throw new Error(
            `Unknown subagent_type "${call.subagentType}". Available agents: ${[...profiles.keys()].join(", ")}.`,
          );
        }
        const model = resolveProfileModel(profile, ctx);
        if (usesPiBackend(profile) && !model) {
          throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");
        }

        // Structured output: native pi subagents get an injected schema-validated
        // structured_output tool. External CLI subagents use their native
        // final-response schema validation instead.
        let capture: StructuredOutputCapture | undefined;
        let customTools: ToolDefinition[] | undefined;
        let appendInstructions: string;
        const externalOutputSchema = !usesPiBackend(profile) && call.schema !== undefined && call.schema !== null;
        if (call.schema !== undefined && call.schema !== null && !externalOutputSchema) {
          capture = { value: undefined, called: false, count: 0, duplicateCall: false };
          customTools = [createStructuredOutputTool(call.schema, capture)];
          appendInstructions = STRUCTURED_OUTPUT_CONTRACT;
        } else if (externalOutputSchema) {
          appendInstructions = [
            WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE,
            "Structured output contract:",
            "- Return only JSON matching the schema supplied to the CLI. No markdown fences or prose.",
          ].join("\n");
        } else {
          appendInstructions = WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE;
        }

        const childIndex = call.index ?? ++agentSeq;
        const childId = `${toolCallId}:agent:${childIndex}`;
        const result = await spawnSubagent({
          toolCallId: childId,
          description: call.label,
          prompt: call.prompt,
          profile,
          model,
          thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
          ctx,
          signal: agentSignal,
          timeoutMs: options.getSubagentTimeoutMs(),
          progressEnabled: true,
          onProgress: (partial) => {
            const details = partial.details as SubagentToolDetails;
            const agent = snapshot.agents.find((item) => item.index === childIndex);
            if (agent && details.progress) {
              agent.startedAt = details.progress.startedAt;
              agent.endedAt = details.progress.endedAt;
              agent.activity = [...details.progress.activity];
              agent.activityCount = details.progress.activityCount;
              agent.result = details.progress.result;
              agent.error = details.progress.error;
              agent.usage = details.progress.usage;
              agent.status = details.progress.status;
              emit();
            }
          },
          onUsage: (usage) => options.updateStatus(ctx, childId, usage),
          excludeTools: CHILD_EXCLUDED_TOOLS,
          appendInstructions,
          customTools,
          outputSchema: externalOutputSchema ? call.schema : undefined,
        });
        const resultDetails = result.details as SubagentToolDetails;
        const agent = snapshot.agents.find((item) => item.index === childIndex);
        if (agent) {
          const progress = resultDetails.progress;
          agent.status = resultDetails.status;
          agent.result = resultDetails.result;
          agent.error = resultDetails.error;
          agent.usage = resultDetails.usage;
          if (progress) {
            agent.startedAt = progress.startedAt;
            agent.endedAt = progress.endedAt;
            agent.activity = [...progress.activity];
            agent.activityCount = progress.activityCount;
          }
          emit();
        }
        if (resultDetails.status !== "done") {
          throw new Error(resultDetails.error ?? "subagent failed");
        }
        if (externalOutputSchema) {
          try {
            return JSON.parse(resultDetails.result ?? "null");
          } catch {
            throw new Error("external subagent structured output was not valid JSON");
          }
        }
        if (capture) {
          if (!capture.called) {
            throw new Error("subagent finished without calling structured_output");
          }
          return capture.value;
        }
        return resultDetails.result ?? "";
      };

      // Spinner animation is driven here, by the runtime, not by a UI-render
      // timer: while any agent is running we advance a frame counter and re-emit
      // so the live row redraws. The interval's lifecycle is bound to this
      // execute() call (cleared in the finally below), so it cannot outlive the
      // workflow or a torn-down tool row — and renderResult stays a pure function
      // of the snapshot, which also keeps non-live paths (HTML export) timer-free.
      const heartbeat = setInterval(() => {
        if (snapshot.status === "running" && snapshot.agents.some((agent) => isActiveSubagentStatus(agent.status))) {
          snapshot.frame = (snapshot.frame ?? 0) + 1;
          emit();
        }
      }, SPINNER_INTERVAL_MS);
      (heartbeat as { unref?: () => void }).unref?.();

      try {
        const runResult = await runWorkflow(script, {
          args: params.args,
          cwd: ctx.cwd,
          signal,
          limiter: options.getLimiter(),
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
          onAgentQueued: (event) => {
            snapshot.agents.push({
              index: event.index,
              label: event.label,
              phase: event.phase,
              subagentType: event.subagentType,
              backend: profiles.get(event.subagentType)?.backend,
              status: "queued",
              startedAt: Date.now(),
              activity: [],
              activityCount: 0,
            });
            snapshot.agentCount = snapshot.agents.length;
            emit();
          },
          onAgentStart: (event) => {
            let agent = snapshot.agents.find((item) => item.index === event.index);
            if (!agent) {
              agent = {
                index: event.index,
                label: event.label,
                phase: event.phase,
                subagentType: event.subagentType,
                backend: profiles.get(event.subagentType)?.backend,
                status: event.cached ? "done" : "running",
                activity: [],
                activityCount: 0,
              };
              snapshot.agents.push(agent);
            }
            agent.status = event.cached ? "done" : "running";
            agent.startedAt = Date.now();
            snapshot.agentCount = snapshot.agents.length;
            if (event.cached) {
              agent.endedAt = agent.startedAt;
              snapshot.cachedAgentCount = (snapshot.cachedAgentCount ?? 0) + 1;
            }
            emit();
          },
          onAgentEnd: (event) => {
            const agent = snapshot.agents.find((item) => item.index === event.index);
            if (agent) {
              agent.status = event.failed ? "error" : "done";
              agent.endedAt = Date.now();
              if (event.failed && !agent.error) {
                agent.error = "subagent failed";
              }
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
          `Workflow "${runResult.meta.name}" completed with ${runResult.agentCount} agent(s)${cachedText}.${scriptPathText}${runIdText}${formatWarnings(warnings)}${formatRecentLogs(snapshot.logs)}\n\nResult:\n${resultText}`,
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
          if (isActiveSubagentStatus(agent.status)) {
            agent.status = aborted ? "aborted" : "error";
            agent.endedAt = Date.now();
          }
        }
        return workflowResult(
          `Workflow "${metaName}" ${aborted ? "aborted" : "failed"}: ${message}${formatRecentLogs(snapshot.logs)}`,
          cloneSnapshot(snapshot),
        );
      } finally {
        clearInterval(heartbeat);
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
      // Pure function of the snapshot: the spinner frame is carried on the
      // snapshot itself and advanced by the runtime heartbeat in execute(), so
      // there is no UI-side timer to leak when a row is torn down or rendered in
      // a non-live context (e.g. HTML export).
      const details = result.details as WorkflowToolDetails;
      return renderWorkflowSnapshot(details, theme, details.frame ?? 0);
    },
  });
}

function agentRenderPriority(agent: WorkflowAgentSnapshot): number {
  if (agent.status === "error" || agent.status === "aborted") return 0;
  if (agent.status === "running") return 1;
  if (agent.status === "queued") return 2;
  return 3;
}

// Pick which agents to show when a phase exceeds `max` rows. Errors first, then
// running, then done (surface failures and active work over finished agents);
// within a tier keep the EARLIEST-started agents so the visible window reads
// #1..#max with `... N more` standing for the later, hidden ones. (A descending
// tie-break here would keep the highest indices and make the list look like it
// starts mid-way.) The final ascending sort restores numeric order across tiers.
function selectAgentsForRender(agents: WorkflowAgentSnapshot[], max = 6): WorkflowAgentSnapshot[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => agentRenderPriority(a.agent) - agentRenderPriority(b.agent) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.agent);
}

// Ordered list of phase groups: planned phases first, then entered runtime
// phases, then agent-only phases, then an `undefined` bucket for unphased
// agents. Planned phases are visible before their first agent starts; runtime
// phases are kept even before their first agent starts so live phase() updates
// stay visible. Layout inspired by Michaelliv/pi-dynamic-workflows.
function orderedPhases(details: WorkflowToolDetails): (string | undefined)[] {
  const seen = new Set<string>();
  const order: (string | undefined)[] = [];
  for (const planned of details.plannedPhases ?? []) {
    if (!seen.has(planned.title)) {
      seen.add(planned.title);
      order.push(planned.title);
    }
  }
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

function isFailedWorkflowAgent(agent: WorkflowAgentSnapshot): boolean {
  return agent.status === "error" || agent.status === "aborted";
}

function workflowRunningCount(details: WorkflowToolDetails): number {
  return details.agents.filter((agent) => agent.status === "running").length;
}

function renderPhaseTree(container: Container, details: WorkflowToolDetails, theme: Theme, frame: number): void {
  const runningCount = workflowRunningCount(details);
  for (const phase of orderedPhases(details)) {
    const agents = details.agents.filter((agent) => agent.phase === phase);
    const pDone = agents.filter((agent) => isCompletedSubagentStatus(agent.status)).length;
    const pErr = agents.filter(isFailedWorkflowAgent).length;
    const pRun = agents.filter((agent) => agent.status === "running").length;
    const pQueued = agents.filter((agent) => agent.status === "queued").length;
    const isCurrent = phase !== undefined && details.currentPhase === phase;
    const reached = phase === undefined || details.phases.includes(phase);
    const workflowRunning = details.status === "running";
    const workflowFailed = details.status === "error" || details.status === "aborted";
    const phaseStatus = pErr > 0 || (workflowFailed && isCurrent && agents.length === 0)
      ? "failed"
      : pRun > 0 || pQueued > 0 || (workflowRunning && isCurrent)
        ? "running"
        : agents.length > 0 || reached
          ? "done"
          : "planned";
    const marker = phaseStatus === "failed" ? "✗" : phaseStatus === "done" ? "✓" : phaseStatus === "running" ? "▶" : "·";
    container.addChild(
      new Text(
        `  ${theme.fg(pErr ? "error" : "muted", `${marker} ${phase ?? "unphased"} ${phaseStatus} · ${pDone}/${agents.length}`)}`,
        0,
        0,
      ),
    );
    const shown = selectAgentsForRender(agents);
    for (const agent of shown) {
      container.addChild(renderSubagentNode(agent, theme, frame, runningCount, "    "));
    }
    const hidden = agents.length - shown.length;
    if (hidden > 0) {
      container.addChild(new Text(`    ${theme.fg("muted", `... ${hidden} more`)}`, 0, 0));
    }
  }
}

function renderFlatAgents(container: Container, details: WorkflowToolDetails, theme: Theme, frame: number): void {
  const runningCount = workflowRunningCount(details);
  const renderedAgents = selectAgentsForRender(details.agents);
  for (const agent of renderedAgents) {
    container.addChild(renderSubagentNode(agent, theme, frame, runningCount, "  "));
  }
  // selectAgentsForRender keeps the earliest agents, so the hidden ones are the
  // later indices — the "not shown" marker belongs after the visible rows (as in
  // renderPhaseTree), standing for what continues below.
  const hiddenAgents = details.agents.length - renderedAgents.length;
  if (hiddenAgents > 0) {
    container.addChild(new Text(`  ${theme.fg("muted", `... ${hiddenAgents} agent(s) not shown`)}`, 0, 0));
  }
}

function renderWorkflowSnapshot(details: WorkflowToolDetails, theme: Theme, frame: number): Container {
  const container = new Container();
  const done = details.agents.filter((agent) => isCompletedSubagentStatus(agent.status)).length;
  const counts = `${done}/${details.agents.length}`;
  container.addChild(
    new Text(
      `${theme.bold(`Workflow(${details.name})`)} ${theme.fg("dim", `${details.status} · ${counts}`)}`,
      0,
      0,
    ),
  );

  // Phase-grouped tree when the workflow uses phase() (including before the first
  // agent in a phase starts); otherwise keep the flat list.
  if ((details.plannedPhases?.length ?? 0) > 0 || details.phases.length > 0 || details.agents.some((agent) => agent.phase)) {
    renderPhaseTree(container, details, theme, frame);
  } else {
    renderFlatAgents(container, details, theme, frame);
  }

  for (const line of details.logs.slice(-3)) {
    container.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
  }

  if (details.error) {
    container.addChild(new Text(`  ${theme.fg("error", details.error)}`, 0, 0));
  }

  return container;
}
