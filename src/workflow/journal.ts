import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { hashStableValue } from "./replay-cache.ts";
import type { WorkflowAgentResultEvent, WorkflowCachedAgentResult } from "./types.ts";

const JOURNAL_VERSION = 1;
const RUN_ID_PREFIX = "wf_";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface WorkflowSessionManagerLike {
  isPersisted?: () => boolean;
  getSessionFile?: () => string | undefined;
  getSessionDir?: () => string | undefined;
  getSessionId?: () => string | undefined;
}

export interface WorkflowSessionContextLike {
  sessionManager?: WorkflowSessionManagerLike;
}

export interface WorkflowRunIdentity {
  runId: string;
  scriptHash: string;
  argsHash: string;
}

export interface LoadedWorkflowJournal {
  runId: string;
  path: string;
  agentResults: WorkflowCachedAgentResult[];
}

export interface WorkflowJournalWriter {
  runId: string;
  path: string;
  appendAgentResult(event: WorkflowAgentResultEvent): Promise<void>;
  complete(result: unknown): Promise<void>;
  fail(error: string): Promise<void>;
}

export function getSessionWorkflowDir(ctx: WorkflowSessionContextLike): string | undefined {
  const manager = ctx.sessionManager;
  if (!manager || manager.isPersisted?.() === false) {
    return undefined;
  }
  const sessionFile = manager.getSessionFile?.();
  if (sessionFile) {
    return join(dirname(sessionFile), `${basename(sessionFile, extname(sessionFile))}.workflows`);
  }
  const sessionDir = manager.getSessionDir?.();
  const sessionId = manager.getSessionId?.();
  if (!sessionDir || !sessionId) {
    return undefined;
  }
  return join(sessionDir, `${safeFilePart(sessionId)}.workflows`);
}

export function createWorkflowRunIdentity(script: string, args: unknown): WorkflowRunIdentity {
  const scriptHash = hashStableValue(script);
  const argsHash = hashStableValue(args ?? null);
  return {
    scriptHash,
    argsHash,
    runId: `${RUN_ID_PREFIX}${hashStableValue({ scriptHash, argsHash }).slice(0, 8)}_${randomUUID().replace(/-/g, "")}`,
  };
}

export async function persistWorkflowScript(params: {
  dir: string;
  metaName: string;
  scriptHash: string;
  script: string;
}): Promise<string> {
  await mkdir(params.dir, { recursive: true });
  const path = join(params.dir, `${safeFilePart(params.metaName)}-${params.scriptHash.slice(0, 12)}.js`);
  await writeFile(path, params.script, "utf8");
  return path;
}

export async function loadWorkflowJournal(dir: string, runId: string): Promise<LoadedWorkflowJournal | undefined> {
  if (!SAFE_ID.test(runId)) {
    throw new Error(`Invalid workflow run id: ${runId}`);
  }
  const path = workflowJournalPath(dir, runId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const agentResults: WorkflowCachedAgentResult[] = [];
  let seenRunStart = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      break;
    }
    if (entry.type === "run_start") {
      seenRunStart = entry.runId === runId;
      continue;
    }
    if (entry.type !== "agent_result") {
      continue;
    }
    const index = entry.index;
    const fingerprint = entry.fingerprint;
    if (typeof index !== "number" || typeof fingerprint !== "string") {
      continue;
    }
    agentResults[index - 1] = { index, fingerprint, result: entry.result, failed: entry.failed === true };
  }

  if (!seenRunStart) {
    throw new Error(`Workflow journal ${path} does not match run id ${runId}`);
  }
  return { runId, path, agentResults };
}

export async function createWorkflowJournalWriter(params: {
  dir: string;
  identity: WorkflowRunIdentity;
  name: string;
  source: string;
  scriptPath?: string;
  resumeFromRunId?: string;
}): Promise<WorkflowJournalWriter> {
  await mkdir(params.dir, { recursive: true });
  const path = workflowJournalPath(params.dir, params.identity.runId);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "run_start",
      version: JOURNAL_VERSION,
      runId: params.identity.runId,
      name: params.name,
      source: params.source,
      scriptPath: params.scriptPath,
      resumeFromRunId: params.resumeFromRunId,
      scriptHash: params.identity.scriptHash,
      argsHash: params.identity.argsHash,
    })}\n`,
    "utf8",
  );

  let appendQueue = Promise.resolve();
  const enqueueAppend = (value: unknown) => {
    const next = appendQueue.then(() => appendJsonLine(path, value));
    appendQueue = next.catch(() => {});
    return next;
  };

  return {
    runId: params.identity.runId,
    path,
    appendAgentResult: async (event) => {
      await enqueueAppend({
        type: "agent_result",
        index: event.index,
        fingerprint: event.fingerprint,
        label: event.label,
        phase: event.phase,
        subagentType: event.subagentType,
        prompt: event.prompt,
        schema: event.schema,
        cached: event.cached,
        failed: event.failed === true,
        result: event.result,
      });
    },
    complete: async (result) => {
      await enqueueAppend({ type: "run_complete", result });
    },
    fail: async (error) => {
      await enqueueAppend({ type: "run_error", error });
    },
  };
}

function workflowJournalPath(dir: string, runId: string): string {
  return join(dir, `run-${runId}.jsonl`);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
