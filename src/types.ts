export type SubagentType = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SubagentProfile {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
}

export interface SubagentExtensionOptions {
  /**
   * Maximum number of subagents allowed to run concurrently across the whole
   * agent run (a global in-flight cap, not a per-level fan-out width). A slot is
   * taken when a subagent launches and released when it completes, fails, or is
   * aborted.
   */
  maxConcurrency?: number;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

export interface SubagentProgressNode {
  id: string;
  description: string;
  subagentType: SubagentType | "unknown";
  status: "running" | "completed" | "rejected" | "error";
  startedAt: number;
  endedAt?: number;
  activity: string[];
  activityCount: number;
  result?: string;
  error?: string;
  usage?: SubagentUsage;
}

export interface SubagentToolDetails {
  description: string;
  subagentType: SubagentType | "unknown";
  status: "running" | "completed" | "rejected" | "error";
  result?: string;
  error?: string;
  usage?: SubagentUsage;
  progress?: SubagentProgressNode;
}
