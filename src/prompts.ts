import type { SubagentType } from "./types.ts";

export const PRESET_DESCRIPTIONS: Record<SubagentType, string> = {
  "general-purpose":
    "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
  explorer:
    "Fast read-only search agent for locating code, mapping repositories, tracing references, and reporting concise findings.",
};

export const AGENT_PROMPT_SNIPPET =
  "Launch a fresh subagent when the task matches an available agent, can run independently, or would read across several files.";

export const AGENT_PROMPT_GUIDELINES = [
  "Reach for Agent when the task matches an available agent, when you have independent work to run in parallel, or when answering would mean reading across several files.",
  "Use explorer for repository reconnaissance, locating files, grepping symbols or keywords, tracing references, and concise read-only findings.",
  "Use general-purpose for researching complex questions, broader multi-step investigations, or independent second opinions.",
  "For a single-fact lookup where you already know the file, symbol, or value, search directly instead of spawning a subagent.",
  "Once you delegate a search, do not also run the same search yourself; wait for the result and keep the conclusion, not raw file dumps.",
  "If the user asks to explore or survey a repo, use explorer to produce a concise map before doing detailed follow-up yourself.",
  "If the user asks for parallel work, launch multiple Agent calls in the same assistant response.",
  "Write self-contained subagent prompts: fresh subagents do not inherit parent conversation, tool results, or reasoning.",
  "Subagents cannot launch Agent themselves; coordinate any follow-up delegation from the main conversation after a result returns.",
  "Clearly tell the subagent whether you expect read-only research or code changes.",
  "The Agent final message is returned to you as the tool result and is not shown to the user; relay what matters.",
];

function formatAvailableAgents(agentDescriptions: Record<string, string>): string {
  return Object.entries(agentDescriptions)
    .map(([name, description]) => `- ${name}: ${description}`)
    .join("\n");
}

export function getPresetAppendPrompt(subagentType: SubagentType): string | undefined {
  if (subagentType === "general-purpose") {
    return undefined;
  }

  return `# Explorer Subagent Role

You are a file search specialist. Your job is to find and analyze existing project files efficiently, then report clear findings to the caller.

This is a read-only exploration task by role. Do not create, edit, delete, move, copy, or install anything. Do not use shell redirects, heredocs, or commands that change project state.

Use dedicated file tools for search and reading when available. Use shell commands only for read-only inspection such as listing files, checking git status, viewing diffs, or printing command output.

Adapt your search breadth to the caller's prompt. For targeted lookups, be fast and direct. For broad investigations, search across multiple names, paths, and conventions before concluding.

Return a concise final report with the relevant files, symbols, and caveats. Do not create documentation files.`;
}

export function buildCoordinatorPrompt(): string {
  return `# Subagent Delegation

Available agents:
${formatAvailableAgents(PRESET_DESCRIPTIONS)}

Use Agent when a specialized agent matches the task, the work can run independently, or delegating would keep large search/read output out of the main context.

Guidelines:
- Do not use subagents excessively; direct lookup is better when the target file, symbol, or value is already known.
- If the user asks for parallel work, launch independent Agent calls in the same assistant response.
- Subagents start fresh and do not inherit parent messages, tool results, or reasoning. Brief them with all needed context.
- Subagents cannot launch other subagents. Coordinate follow-up delegation from the main conversation after each result returns.
- The Agent final message is returned to you as the tool result. Relay what matters to the user.

Example usage:
- User asks "explore this repo": use Agent with subagent_type "explorer" and ask it to map the project purpose, key directories, important files, scripts, tests, and caveats without editing files.
- User asks for a second opinion on a risky change: use Agent with subagent_type "general-purpose" and give it enough context to review independently.

Root-level parallel delegation is bounded by the extension. If the limit is reached, the Agent tool will reject the call.`;
}
