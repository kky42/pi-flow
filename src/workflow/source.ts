import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { WorkflowToolDetails } from "../types.ts";
import {
  createWorkflowJournalWriter,
  createWorkflowRunIdentity,
  getSessionWorkflowDir,
  loadWorkflowJournal,
  persistWorkflowScript,
  type WorkflowJournalWriter,
  type WorkflowRunIdentity,
} from "./journal.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "./registry.ts";
import { parseWorkflowScript } from "./script-validation.ts";
import type { WorkflowCachedAgentResult, WorkflowMetaPhase } from "./types.ts";

export const workflowToolParameters = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script (no Markdown fences) for an ad-hoc workflow.",
        "First statement: export const meta = { name: 'short_name', description: 'non-empty' }.",
        "Use agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Must call agent() at least once and return a JSON-serializable value. Results are canonicalized to JSON; non-plain objects are rejected.",
        "Provide exactly one of `script`, `name`, or `scriptPath`.",
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

export type WorkflowToolParams = Static<typeof workflowToolParameters>;

export type PreparedWorkflowToolSource = {
  script: string;
  metaName: string;
  plannedPhases?: WorkflowMetaPhase[];
  source: "inline" | "saved" | "path";
  sourcePath?: string;
  scriptPath?: string;
  warnings: string[];
  identity: WorkflowRunIdentity;
  journalWriter?: WorkflowJournalWriter;
  resumeFromRunId?: string;
  resumeAgentResults?: WorkflowCachedAgentResult[];
};

type PrepareErrorDetails = Partial<WorkflowToolDetails> & { name: string; error: string };

export type PrepareWorkflowToolSourceResult =
  | { ok: true; value: PreparedWorkflowToolSource }
  | { ok: false; text: string; details: PrepareErrorDetails };

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

function sourceError(text: string, details: PrepareErrorDetails): PrepareWorkflowToolSourceResult {
  return { ok: false, text, details };
}

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

export function normalizeWorkflowScript(script: string): string {
  let text = typeof script === "string" ? script.trim() : "";
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) {
    text = fence[1].trim();
  }
  return text;
}

export async function prepareWorkflowToolSource(
  params: WorkflowToolParams,
  ctx: ExtensionContext,
): Promise<PrepareWorkflowToolSourceResult> {
  const source = resolveWorkflowSource(params, ctx);
  if (!source.ok) {
    return sourceError(`${source.message}${formatWarnings(source.warnings)}`, {
      name: "workflow",
      error: source.message,
      logs: source.warnings,
    });
  }

  const script = normalizeWorkflowScript(source.script);
  let metaName = source.requestedName ?? "workflow";
  let plannedPhases: WorkflowMetaPhase[] | undefined;
  try {
    const parsed = parseWorkflowScript(script);
    metaName = parsed.meta.name;
    plannedPhases = parsed.meta.phases?.map((phase) => ({ ...phase }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sourceError(`Workflow script is invalid: ${message}`, {
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
    return sourceError(message, {
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
      scriptPath = await persistWorkflowScript({ dir: sessionWorkflowDir, metaName, scriptHash: identity.scriptHash, script });
    } catch (error) {
      const message = `Workflow persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      return sourceError(message, {
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
      return sourceError(message, {
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
      return sourceError(message, {
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
      return sourceError(message, {
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
      return sourceError(message, {
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

  return {
    ok: true,
    value: {
      script,
      metaName,
      plannedPhases,
      source: source.source,
      sourcePath: source.sourcePath,
      scriptPath,
      warnings: source.warnings,
      identity,
      journalWriter,
      resumeFromRunId,
      resumeAgentResults,
    },
  };
}
