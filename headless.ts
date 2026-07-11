import { join } from "node:path";
import { AuthStorage, getAgentDir, ModelRegistry, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConcurrencyLimiter } from "./src/core/concurrency.ts";
import { getSubagentProfiles } from "./src/profiles.ts";
import type { SubagentBackend, SubagentUsage } from "./src/types.ts";
import { createWorkflowAgentRunner } from "./src/workflow/agent-runner.ts";
import { isWorkflowAbortError, runWorkflow, type WorkflowLimits } from "./src/workflow/runtime.ts";

export interface HeadlessUsage extends SubagentUsage { childAgents: number }
export interface HeadlessWorkflowOptions {
  script: string;
  cwd: string;
  args?: unknown;
  signal?: AbortSignal;
  maxConcurrentSubagents?: number;
  subagentTimeoutMs?: number;
  workflowTimeoutMs?: number;
  allowedBackends?: readonly SubagentBackend[];
  limits?: Partial<WorkflowLimits>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onUsage?: (usage: HeadlessUsage) => void;
}
export interface HeadlessWorkflowResult<T = unknown> { result: T; logs: string[]; phases: string[]; agentCount: number; usage: HeadlessUsage }
export type HeadlessWorkflowErrorCode = "ABORTED" | "WORKFLOW_TIMEOUT" | "EXECUTION_FAILED";
export class HeadlessWorkflowError extends Error {
  constructor(message: string, readonly code: HeadlessWorkflowErrorCode, readonly usage: HeadlessUsage, options?: ErrorOptions) {
    super(message, options); this.name = "HeadlessWorkflowError";
  }
}

/** Execute a trusted pi-flow script without an ExtensionContext or TUI. */
export async function executeWorkflow<T = unknown>(options: HeadlessWorkflowOptions): Promise<HeadlessWorkflowResult<T>> {
  const agentDir = getAgentDir();
  const auth = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(auth, join(agentDir, "models.json"));
  const settings = SettingsManager.create(options.cwd, agentDir);
  const defaultProvider = settings.getDefaultProvider();
  const defaultModel = settings.getDefaultModel();
  const configuredModel = defaultProvider && defaultModel
    ? modelRegistry.find(defaultProvider, defaultModel)
    : undefined;
  const model = configuredModel ?? (await modelRegistry.getAvailable())[0];
  const ctx = { cwd: options.cwd, modelRegistry, model } as ExtensionContext;
  const usage: HeadlessUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, childAgents: 0 };
  const agentUsage = new Map<number, SubagentUsage>();
  const updateUsage = (index: number, next: SubagentUsage) => {
    agentUsage.set(index, next);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
      usage[key] = [...agentUsage.values()].reduce((sum, item) => sum + (item[key] ?? 0), 0);
    }
    const values = [...agentUsage.values()];
    usage.costKnown = values.every((item) => item.costKnown !== false);
    usage.costEstimated = values.some((item) => item.costEstimated === true);
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    usage.latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
    options.onUsage?.({ ...usage });
  };
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let timeoutTriggered = false;
  const timer = options.workflowTimeoutMs ? setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, options.workflowTimeoutMs) : undefined;
  timer?.unref?.();
  const runner = createWorkflowAgentRunner({
    profiles: getSubagentProfiles(agentDir), ctx,
    thinkingLevel: settings.getDefaultThinkingLevel(),
    timeoutMs: options.subagentTimeoutMs ?? 3_600_000,
    allowedBackends: options.allowedBackends,
    onUsage: updateUsage,
  });
  try {
    const result = await runWorkflow<T>(options.script, {
      cwd: options.cwd, args: options.args, signal,
      limiter: new ConcurrencyLimiter(options.maxConcurrentSubagents ?? 12),
      runAgent: runner.runAgent, serializeAgent: runner.serializeAgent,
      limits: options.limits, onLog: options.onLog, onPhase: options.onPhase,
      onAgentStart: () => { usage.childAgents++; options.onUsage?.({ ...usage }); },
    });
    return { result: result.result, logs: result.logs, phases: result.phases, agentCount: result.agentCount, usage: { ...usage } };
  } catch (cause) {
    const timeout = timeoutTriggered;
    const aborted = options.signal?.aborted || isWorkflowAbortError(cause);
    throw new HeadlessWorkflowError(cause instanceof Error ? cause.message : String(cause), timeout ? "WORKFLOW_TIMEOUT" : aborted ? "ABORTED" : "EXECUTION_FAILED", { ...usage }, { cause });
  } finally { if (timer) clearTimeout(timer); }
}
