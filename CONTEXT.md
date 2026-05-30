# pi-subagent

This context describes the domain language for a lightweight Claude Code-style subagent extension for pi agent.

## Language

**Subagent**:
A delegated pi agent instance that handles a scoped task in a fresh conversation and returns a final report to its caller. In this project, the unqualified term refers to foreground delegation; background jobs are outside the current meaning.
_Avoid_: Background task, worker, scheduled agent

**Delegation Width**:
The maximum number of direct subagents the main agent may spawn in one foreground delegation turn. In the synchronous v1 design this is a quota, not a concurrency limit.
_Avoid_: Concurrency, parallelism

**Foreground Parallel Delegation**:
Multiple foreground subagents launched by one caller turn and awaited before the caller continues. It is distinct from background delegation because no long-lived result retrieval or notification state is created.
_Avoid_: Background execution

**Fresh Subagent Context**:
A subagent conversation that starts with no parent messages, tool results, or reasoning, while still loading the normal pi project environment for the same working directory. The caller must include any needed conversation-specific context in the delegated prompt.
_Avoid_: Inherited context, forked context

**Preset Subagent**:
A built-in subagent profile selected by name. In v1, preset subagents are ordinary pi agents; `general-purpose` has no role specialization, while `explorer` adds role guidance rather than tool or permission restrictions.
_Avoid_: Custom agent, permission profile

**Explorer**:
The file-search preset subagent. It is selected as `explorer` and has no aliases.
_Avoid_: Explore

## Example Dialogue

Developer: "Should this subagent keep the parent conversation?"
Domain expert: "No. A subagent starts fresh, so the caller must brief it with the task, relevant context, and expected output."

Developer: "Can a subagent call another subagent?"
Domain expert: "No. V1 matches Claude Code's root-orchestrated model: the main agent can launch subagents, and subagents cannot launch other subagents."

Developer: "Does Explorer technically block file writes?"
Domain expert: "Not in v1. It is prompted to stay read-only, but it still runs as a normal pi agent."

Developer: "If the caller emits two Agent tool calls in one turn, is that background work?"
Domain expert: "No. Those are foreground parallel delegations; the caller waits for both results before its next reasoning step."

Developer: "Can users set delegation limits through flags?"
Domain expert: "Not in v1. The extension has fixed default limits unless embedded code supplies different values."
