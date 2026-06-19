import type { ConcurrencyLimiter } from "../core/concurrency.ts";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
}

/** A single agent() invocation requested by a workflow script. */
export interface WorkflowAgentCall {
  index?: number;
  prompt: string;
  label: string;
  phase?: string;
  subagentType: string;
  /** JSON Schema for structured output from the child subagent. */
  schema?: unknown;
}

export interface WorkflowCachedAgentResult {
  index: number;
  fingerprint: string;
  result: unknown;
  failed?: boolean;
}

export interface WorkflowAgentResultEvent extends WorkflowCachedAgentResult {
  label: string;
  phase?: string;
  subagentType: string;
  prompt: string;
  schema?: unknown;
  cached: boolean;
}

/**
 * Runs one subagent and resolves with its final text. The workflow tool
 * supplies the real implementation (profile resolution + spawnSubagent); tests
 * inject a fake. Throwing is treated as a per-agent failure (the branch becomes
 * null and is logged) unless the workflow signal aborted.
 */
export type WorkflowAgentRunner = (
  call: WorkflowAgentCall,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

export interface WorkflowLimits {
  /** Hard cap on agent() calls per workflow run, including cached calls. */
  maxAgentCalls: number;
  /** Retained workflow log lines. Further logs are summarized/truncated. */
  maxLogs: number;
  /** Maximum retained characters per workflow log line. */
  maxLogLength: number;
  /** Heartbeat sent by the isolated script worker. */
  workerHeartbeatIntervalMs: number;
  /** Kill the isolated script worker only after this much heartbeat silence. */
  workerStallTimeoutMs: number;
  /** Kill a responsive script that makes no workflow progress and has no active agent calls. */
  workerIdleTimeoutMs: number;
  /** Initial synchronous vm execution timeout before the script's first await. */
  syncExecutionTimeoutMs: number;
  /** Old-generation V8 heap cap for the workflow script worker. */
  workerMaxOldGenerationSizeMb: number;
  /** Young-generation V8 heap cap for the workflow script worker. */
  workerMaxYoungGenerationSizeMb: number;
  /** Worker stack cap. */
  workerStackSizeMb: number;
  /** Cooperative abort grace period before terminating an unresponsive worker. */
  abortGraceMs: number;
}

export interface RunWorkflowOptions {
  args?: unknown;
  cwd: string;
  signal?: AbortSignal;
  /** Shared global concurrency cap; agent() queues on this. */
  limiter: ConcurrencyLimiter;
  runAgent: WorkflowAgentRunner;
  defaultSubagentType?: string;
  limits?: Partial<WorkflowLimits>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  resumeAgentResults?: WorkflowCachedAgentResult[];
  onAgentQueued?: (event: { index: number; label: string; phase?: string; subagentType: string; prompt: string }) => void;
  onAgentStart?: (event: { index: number; label: string; phase?: string; subagentType: string; prompt: string; cached?: boolean }) => void;
  onAgentEnd?: (event: { index: number; label: string; phase?: string; result: unknown; cached?: boolean; failed?: boolean }) => void;
  onAgentResult?: (event: WorkflowAgentResultEvent) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
}
