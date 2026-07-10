export type BasicMetricsAgent = "claude-code" | "codex" | "pi";
export type BasicMetricsCostPolicy = "required" | "allow-upstream-unknown";
export type BasicMetricsStatus = "pass" | "warn" | "fail";
export type BasicMetricsCostStatus = "reported" | "estimated" | "unknown";
export type BasicMetricsCheckStatus = "pass" | "warn" | "fail";

export interface BasicMetricsRow {
  id: string;
  agent: BasicMetricsAgent;
  model: string;
  invocationModel: string;
  thinking: "medium";
  costPolicy: BasicMetricsCostPolicy;
  expectedToken: string;
}

export interface ProbeProcessResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface ProbeUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cacheHitRate: number | undefined;
  costUsd: number;
  costStatus: BasicMetricsCostStatus;
}

export interface ProbeSummary {
  id: string;
  agent: BasicMetricsAgent;
  model: string;
  thinking: string;
  durationMs: number;
  status: BasicMetricsStatus;
  observedModels: string[];
  toolCalls: number;
  toolErrors: number;
  resultTokenFound: boolean;
  usage: ProbeUsageSummary | undefined;
  usageDisplay: string;
  checks: {
    process: BasicMetricsCheckStatus;
    completion: BasicMetricsCheckStatus;
    model: BasicMetricsCheckStatus;
    tool: BasicMetricsCheckStatus;
    result: BasicMetricsCheckStatus;
    usage: BasicMetricsCheckStatus;
    tokens: BasicMetricsCheckStatus;
    cacheHitRate: BasicMetricsCheckStatus;
    cost: BasicMetricsCheckStatus;
    display: BasicMetricsCheckStatus;
  };
  warnings: string[];
  errors: string[];
}

export const BASIC_METRICS_ROWS: readonly Readonly<BasicMetricsRow>[];

export function buildProbeInvocation(row: BasicMetricsRow): {
  command: "claude" | "codex" | "pi";
  args: string[];
};

export function parseJsonLines(text: string): {
  events: Record<string, unknown>[];
  malformedLines: string[];
};

export function summarizeProbe(options: {
  row: BasicMetricsRow;
  events: Record<string, any>[];
  durationMs: number;
  processResult: ProbeProcessResult;
}): ProbeSummary;
