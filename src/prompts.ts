import type { SavedWorkflow } from "./workflow/registry.ts";
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
  "Pi-backed subagents do not receive Agent; external CLI backends use their own tool surface. Coordinate follow-up delegation from the main conversation after a result returns.",
  "Clearly tell the subagent whether you expect read-only research or code changes.",
  "The Agent final message is returned to you as the tool result and is not shown to the user; relay what matters.",
];

export const WORKFLOW_PROMPT_SNIPPET =
  "Run a saved or ad-hoc trusted JavaScript workflow that fans subagents out and synthesizes their results, when the user asks for a workflow or multi-agent orchestration.";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration, when a saved workflow matches the user's request, or when a task decomposes into many independent subagent runs that you then synthesize.",
  "Prefer `workflow({ name, args })` when an available saved workflow matches the request. Use `workflow({ scriptPath, resumeFromRunId, args })` to rerun or resume an edited persisted script. Use inline `script` only for ad-hoc orchestration.",
  "If the user asks to save a reusable workflow, copy or write a `.js` file directly to `~/.pi/agent/workflows/` for global scope or `.pi/workflows/` for project scope. Project workflows are ignored unless the project is trusted. The file must start with `export const meta = { name, description }`; use a filename that exactly matches the workflow name. After saving, invoke it with `workflow({ name, args })`.",
  "For inline scripts, pass one raw JavaScript string in the `script` parameter. No Markdown fences, no prose around it. Inline runs in persisted sessions return `scriptPath` and `runId` for later editing/resume; in-memory runs may only return `runId`.",
  "The script's first statement must be `export const meta = { name: 'short_name', description: 'non-empty description' }`. meta must be a plain literal.",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Every workflow must call agent() at least once and return a JSON-serializable value (use null if there is no synthesized result). Results are canonicalized to JSON; non-plain objects are rejected.",
  "Write plain JavaScript only. Do not use TypeScript syntax, import/require, fs, Date APIs, or Math.random(). Simple Date/Math.random aliases and destructuring are rejected too. Scripts are trusted code; the determinism check is a cooperative lint, not a sandbox.",
  "parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`. Results come back in input order.",
  "pipeline(items, ...stages) runs each item through the stages in order while different items run concurrently; each stage receives (previousValue, originalItem, index). Prefer pipeline() for multi-stage work — there is no barrier between stages. Reach for parallel() only when you genuinely need all results together, e.g. dedup or a zero-count early exit.",
  "Give each agent() a unique short `label` and pick a `subagent_type` (defaults to general-purpose) so it uses that profile's configured backend, model, thinking level, prompt, and pi-backend tool allowlist.",
  "Pass a JSON Schema as agent()'s `schema` option whenever the script must branch, route, filter, or aggregate on a result: the subagent is forced to return one validated object (agent() resolves to that object instead of text), so `if (r.kind === ...)` / `flags.filter(...)` are reliable. Omit `schema` for prose findings you only read or synthesize.",
  "Subagents are fresh sessions with no parent context. Pi-backed subagents do not receive Agent/workflow; external CLI backends use their own tool surface. Include all needed context and paths in each agent() prompt.",
  "Failed agent()/parallel()/pipeline() branches resolve to null and are logged unless the workflow is aborted; check for nulls before synthesizing.",
];

function formatAvailableAgents(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.values()]
    .map((profile) => `- ${profile.name}: ${profile.description}`)
    .join("\n");
}

function truncateWorkflowText(text: string, maxLength = 180): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatSavedWorkflows(workflows: SavedWorkflow[], maxItems = 20): string {
  if (workflows.length === 0) {
    return "";
  }
  const shown = workflows.slice(0, maxItems);
  const lines = shown.map((workflow) => `- ${workflow.name}: ${truncateWorkflowText(workflow.description)}`);
  if (workflows.length > shown.length) {
    lines.push(`- … ${workflows.length - shown.length} more saved workflow(s) not shown.`);
  }
  return `\n\nSaved workflows:\n${lines.join("\n")}`;
}

export function buildWorkflowPrompt(profiles: Map<string, SubagentProfile>, savedWorkflows: SavedWorkflow[] = []): string {
  return `# Dynamic Workflows

The \`workflow\` tool runs a saved or ad-hoc trusted JavaScript script that orchestrates many subagents and synthesizes their results. Reach for it when the user asks for a workflow or fan-out, when a saved workflow matches the request, or when a task splits into many independent subagent runs.

Tool input:
- Use \`{ name: 'saved-workflow-name', args }\` for a saved workflow listed below.
- Use \`{ scriptPath, args }\` to run a persisted script file. Add \`resumeFromRunId\` to reuse cached agent results from a previous run's unchanged prefix.
- Use \`{ script, args }\` for ad-hoc orchestration. Inline runs in persisted sessions return \`scriptPath\` and \`runId\` for later editing/resume; in-memory runs may only return \`runId\`. Provide exactly one of \`name\`, \`scriptPath\`, or \`script\`.

Inline script contract:
- First statement: \`export const meta = { name: 'short_name', description: 'non-empty' }\` (a plain literal; \`phases\` optional).
- Globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd. Call agent() at least once and return a JSON-serializable value (use \`null\` if there is no synthesized result). Results are canonicalized to JSON; non-plain objects are rejected.
- Plain JavaScript only; no imports, no Date APIs, no Math.random(). Simple Date/Math.random aliases and destructuring are rejected too. Scripts are trusted code; the determinism check is cooperative lint, not a sandbox.
- parallel() takes thunks: \`await parallel(items.map(i => () => agent('...', { label: '...' })))\`. pipeline(items, ...stages) pipelines each item through stages while items run concurrently — prefer it for multi-stage work (no barrier between stages); use parallel() only when you need all results together.

Each agent() spawns a fresh subagent. Set \`subagent_type\` to use a profile's backend, model, thinking, prompt, and pi-backend tool allowlist:
${formatAvailableAgents(profiles)}

agent() options: \`label\` (short unique id), \`phase\` (progress group), \`subagent_type\` (profile above), and \`schema\` (a JSON Schema). Pass \`schema\` when the script must branch, route, filter, or aggregate on the result: the subagent is forced to return one validated object and agent() resolves to that object instead of free text. Omit \`schema\` for prose findings you only synthesize. Example — classify, then dispatch:
\`\`\`
const r = await agent("Classify " + file, { label: "classify", schema: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["entry", "lib", "test"] } } } });
if (r.kind === "entry") { /* ... */ }
\`\`\`

Subagents do not inherit parent context — brief each agent() prompt fully. Pi-backed subagents do not receive Agent/workflow; external CLI backends use their own tool surface. Subagent fan-out is bounded by the same global concurrency cap as the Agent tool; the workflow queues excess agents and drains them as slots free.${formatSavedWorkflows(savedWorkflows)}`;
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
- Pi-backed subagents do not receive Agent; external CLI backends use their own tool surface. Coordinate follow-up delegation from the main conversation after each result returns.
- The Agent final message is returned to you as the tool result. Relay what matters to the user.

Example usage:
- User asks "explore this repo": use Agent with subagent_type "explorer" and ask it to map the project purpose, key directories, important files, scripts, tests, and caveats without editing files.
- User asks for a second opinion on a risky change: use Agent with subagent_type "general-purpose" and give it enough context to review independently.

Root-level parallel delegation is bounded by the extension. If the limit is reached, the Agent tool will reject the call.`;
}
