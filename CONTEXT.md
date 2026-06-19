# pi-flow

This context describes the domain language for `pi-flow`: a lightweight pi extension for foreground subagents, multi-backend agent profiles, and trusted dynamic workflows.

## Language

**Flow**:
The root-agent-controlled coordination of one or more subagents. A flow may be a single `Agent` call or a `workflow` script that launches many `agent()` calls and synthesizes the result.
_Avoid_: Background daemon, hidden scheduler, autonomous swarm

**Subagent**:
A delegated agent instance that handles a scoped task in a fresh conversation and returns a final report to its caller. In this project, the unqualified term refers to foreground delegation.
_Avoid_: Background task, worker, scheduled agent

**Backend Profile**:
A markdown profile selected by `subagent_type`. The profile chooses the backend (`pi`, `codex`, or `claude`), optional model/thinking settings, and optional role prompt. Backend/profile selection is the supported way to route work to different harnesses.
_Avoid_: Per-call model override, hidden provider switch

**Dynamic Workflow**:
A trusted JavaScript script run by the `workflow` tool. It can call `agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, and `log(message)`, then return a JSON-serializable result. Workflows are foreground/blocking and inspectable, not background jobs.
_Avoid_: Long-running service, cron, workflow platform

**Saved Workflow**:
A workflow script stored under `~/.pi/agent/workflows/*.js` or trusted `.pi/workflows/*.js`, identified by `meta.name`, and invoked by natural-language routing through the `workflow` tool.
_Avoid_: Slash command, auto-run hook

**Resume-by-Replay**:
Rerunning a persisted workflow script with `resumeFromRunId` so cached subagent outputs are reused for the longest unchanged prefix of `agent()` calls. The first changed/new call and everything after it runs live.
_Avoid_: Background resume, checkpointed process

**Global Concurrency Limit** (`maxConcurrentSubagents`):
The maximum number of subagents allowed to run concurrently. It is a live in-flight gauge, not a per-turn quota: a slot is taken when a subagent starts running and released when it completes, fails, or is aborted. Requests above the running cap queue and drain as slots free. It defaults to 12, can be set by embedded extension code with `createFlowExtension({ maxConcurrentSubagents })` or `createSubagentExtension({ maxConcurrentSubagents })`, and can be overridden at launch with `--max-concurrent-subagents <n>`.
_Avoid_: Delegation width, fan-out quota, per-turn budget

**Foreground Parallel Delegation**:
Multiple foreground subagents launched by one caller turn and awaited before the caller continues. It is distinct from background delegation because no long-lived result retrieval or notification state is created.
_Avoid_: Background execution

**Fresh Subagent Context**:
A subagent conversation that starts with no parent messages, tool results, or reasoning, while still loading the normal project environment for the same working directory. The caller must include any needed conversation-specific context in the delegated prompt.
_Avoid_: Inherited context, forked context

**Explorer**:
The built-in file-search profile. It is selected as `explorer` and has no aliases.
_Avoid_: Explore

## Example Dialogue

Developer: "Should this subagent keep the parent conversation?"
Domain expert: "No. A subagent starts fresh, so the caller must brief it with the task, relevant context, and expected output."

Developer: "Can a pi-backed subagent call another subagent?"
Domain expert: "No. The main agent coordinates delegation. Pi-backed child sessions do not receive `Agent` or `workflow`. External CLI backends use their own tool surface."

Developer: "Is `workflow` a background workflow engine?"
Domain expert: "No. It is a foreground tool call that runs a trusted JavaScript orchestration script, waits for subagents, and returns one result."

Developer: "Can workflows route lanes to Codex or Claude Code?"
Domain expert: "Yes. Use `subagent_type` to select a profile whose frontmatter sets `backend: codex` or `backend: claude`."

Developer: "Can users set delegation limits through flags?"
Domain expert: "Yes. Use `pi --max-concurrent-subagents <n>`; embedded code can set the default with `createFlowExtension({ maxConcurrentSubagents })`."
