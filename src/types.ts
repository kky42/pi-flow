export type SubagentType = "general-purpose" | "explorer";

export interface SubagentExtensionOptions {
  maxDepth?: number;
  maxWidth?: number;
}

export interface SubagentToolDetails {
  description: string;
  subagentType: SubagentType | "unknown";
  depth: number;
  status: "running" | "completed" | "rejected" | "error";
  result?: string;
  error?: string;
}
