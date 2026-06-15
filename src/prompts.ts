import type { SubagentProfile } from "./types.ts";

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

export const WORKFLOW_PROMPT_SNIPPET =
  "Run a deterministic JavaScript workflow that fans subagents out and synthesizes their results, when the user asks for a workflow or multi-agent orchestration.";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration, or when a task decomposes into many independent subagent runs that you then synthesize.",
  "Pass one raw JavaScript string in the required `script` parameter. No Markdown fences, no prose around it.",
  "The script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty description' }`. meta must be a plain literal.",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Every workflow must call agent() at least once.",
  "Write plain JavaScript only. Do not use TypeScript syntax, import/require, fs, or Date.now()/Math.random()/new Date() (workflows must be deterministic).",
  "parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`. Results come back in input order.",
  "pipeline(items, ...stages) runs each item through the stages in order while different items run concurrently; each stage receives (previousValue, originalItem, index). Prefer pipeline() for multi-stage work — there is no barrier between stages. Reach for parallel() only when you genuinely need all results together, e.g. dedup or a zero-count early exit.",
  "Give each agent() a unique short `label` and pick a `subagent_type` (defaults to general-purpose) so it inherits that profile's real model, thinking level, tools, and system prompt.",
  "Subagents are fresh sessions with no parent context and cannot launch workflows or other subagents; include all needed context and paths in each agent() prompt.",
  "Failed agent()/parallel()/pipeline() branches resolve to null and are logged unless the workflow is aborted; check for nulls before synthesizing.",
];

function formatAvailableAgents(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.values()]
    .map((profile) => `- ${profile.name}: ${profile.description}`)
    .join("\n");
}

export function buildWorkflowPrompt(profiles: Map<string, SubagentProfile>): string {
  return `# Dynamic Workflows

The \`workflow\` tool runs a deterministic JavaScript script that orchestrates many subagents and synthesizes their results. Reach for it when the user asks for a workflow or fan-out, or when a task splits into many independent subagent runs.

Script contract:
- First statement: \`export const meta = { name: 'short_snake_case', description: 'non-empty' }\` (a plain literal; \`phases\` optional).
- Globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Call agent() at least once.
- Plain JavaScript only; no imports, no Date.now()/Math.random()/new Date() (scripts must be deterministic).
- parallel() takes thunks: \`await parallel(items.map(i => () => agent('...', { label: '...' })))\`. pipeline(items, ...stages) pipelines each item through stages while items run concurrently — prefer it for multi-stage work (no barrier between stages); use parallel() only when you need all results together.

Each agent() spawns a fresh subagent. Set \`subagent_type\` to inherit a profile's model, thinking, tools, and system prompt:
${formatAvailableAgents(profiles)}

Subagents cannot launch workflows or other subagents, and do not inherit parent context — brief each agent() prompt fully. Subagent fan-out is bounded by the same global concurrency cap as the Agent tool; the workflow queues excess agents and drains them as slots free.`;
}

export function buildCoordinatorPrompt(profiles: Map<string, SubagentProfile>): string {
  return `# Subagent Delegation

Available agents:
${formatAvailableAgents(profiles)}

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
