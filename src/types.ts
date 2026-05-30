export type SubagentType = "general-purpose" | "explorer";

export interface SubagentExtensionOptions {
  maxWidth?: number;
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
}

export interface SubagentToolDetails {
  description: string;
  subagentType: SubagentType | "unknown";
  status: "running" | "completed" | "rejected" | "error";
  result?: string;
  error?: string;
  progress?: SubagentProgressNode;
}
