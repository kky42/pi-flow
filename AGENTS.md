# Agent Notes

## pi-subagent v1 Contract

- This repo implements a lightweight pi extension, not a fork of `refs/pi-subagents`.
- The registered tool is `Agent`. v2 adds an opt-in `workflow` tool (see "pi-subagent workflows (v2)" below); the v1 contract here still governs the `Agent` tool.
- Tool parameters follow the Claude Code-style shape: `description`, `prompt`, and optional `subagent_type`.
- `description` is UI/routing metadata. `prompt` is the full subagent task.
- V1 presets are `general-purpose` and `explorer`. No aliases.
- `subagent_type` defaults to `general-purpose`.
- `general-purpose` adds no role prompt.
- `explorer` appends a Claude Code Explore-inspired role prompt to pi's normal system prompt.
- Do not replace pi's base system prompt in v1.
- V1 is foreground-only. Do not add background execution, result polling, resume, steering, scheduling, model override, or thinking override.
- Subagents start with a fresh conversation and the same working directory. Parent conversation messages and tool results are not inherited.
- Subagents inherit the caller's current model and thinking level.
- There is no permissions system in v1. Presets are prompt-specialized ordinary pi agents.
- Subagents cannot launch other subagents. Do not give child sessions the `Agent` or `workflow` tool, or the coordinator prompt.
- Parallel delegation is allowed and bounded by a global `maxConcurrency` limit (default `12`), which caps how many subagents run concurrently across the whole agent run. A slot is taken on launch and released on completion/failure/abort. In v2 this same cap is shared with the `workflow` tool.
- Do not put exact concurrency values in the model-facing coordinator prompt. The prompt should say parallel delegation is bounded; enforcement and exact rejection messages come from the tool.
- No user-facing flags in v1. Limit overrides are only through `createSubagentExtension({ maxConcurrency })`.
- User-defined agents are future work. The main-agent prompt may mention that they are not supported yet.

## pi-subagent workflows (v2)

- Adds a second registered tool, `workflow`, alongside `Agent`: one product, two entry points. Built on the same spawn core, not a reimplementation of `refs/pi-dynamic-workflows`.
- Opt-in via `createSubagentExtension({ workflow })`; defaults to `true`. Set `false` for a subagents-only surface (then only `Agent` registers and no workflow prompt is appended).
- The `workflow` tool runs a deterministic, model-written JavaScript script in a `node:vm` sandbox. Globals: `agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`, `cwd`. The script must start with `export const meta = { name, description }` (a plain literal) and call `agent()` at least once.
- Determinism is enforced at parse time via an `acorn` AST scan: `Date.now()`, `Math.random()`, and `new Date()` are rejected. Dynamic authoring, deterministic execution.
- `agent()` reuses the shared spawn core, so a `subagent_type` selects a real profile and the subagent gets that profile's model, thinking level, tools, and system prompt — not stubbed guidance. `agent({ schema })` returns a schema-validated object: a `structured_output` tool is injected into the child via an extension factory (pinned pi `0.77.0` has no `customTools`/`terminate`), the profile tool allow-list is extended to admit it, and the child is contracted to finish with one `structured_output` call.
- Concurrency is the SAME global cap as `Agent`: both tools share one `ConcurrencyLimiter`. `Agent` rejects on limit (`tryAcquire`, model retries next turn); `workflow` queues and drains (`acquire`, a script legitimately submits more than the cap). The `workflow` tool itself does not consume a slot; only its `agent()` calls do.
- Foreground-only still holds: the `workflow` tool blocks until the script completes. No background execution, polling, resume, steering, or scheduling — orchestration is front-loaded into the script, not a reactive coordinator. Per-call model/thinking *override* remains out of contract; profile-based selection via `subagent_type` is the supported path.
- Nesting is hard-blocked: workflow-spawned subagents get neither `Agent` nor `workflow`.
- Do not put exact concurrency values in the model-facing workflow prompt; say fan-out is bounded and queued.
- Architecture: `src/core/{spawn,concurrency,model,progress}.ts` is the shared core; `src/workflow/{runtime,tool,structured-output}.ts` is the workflow layer; `src/pi-subagent.ts` wires both tools and shares one limiter. Adds an `acorn` dependency (the only runtime dependency).

## References Read

- `refs/pi` for pi extension and SDK APIs.
- `refs/pi-subagents` for a broader Claude Code-style implementation.
- `refs/claude-code-system-prompts` for Agent tool guidance and built-in agent prompts.
- Official Claude Code subagent docs: https://code.claude.com/docs/en/sub-agents

## E2E Evidence

Interactive tmux TUI runs use `deepseek/deepseek-v4-flash` with high thinking and isolated `--no-*` resource flags.

- `width`: validates eight parallel foreground `explorer` delegations.
- `proactive-multirepo-v3`: validates proactive parallel delegation for a two-repo auth comparison.
- `proactive-fanout-v3`: validates proactive multi-lane delegation for TODO/FIXME/skipped-test search.
- `proactive-migration-v2`: validates proactive second-opinion delegation for a risky migration review.

Do not count `proactive-ship-v3` as proactive-pass evidence: the model handled that tiny ship-readiness fixture directly. This is acceptable as a behavioral limitation, but future prompt/tool tuning should continue improving this case.

### Workflow tool (v2)

A headless `pi -p` run with `deepseek/deepseek-v4-flash` (high thinking) on a tiny fixture validated the end-to-end workflow path: the model reached for the `workflow` tool (root toolCalls `{bash:2, read:5, workflow:1}`, zero `Agent`), wrote a valid deterministic script (`export const meta`, `parallel([() => agent(prompt, { label, subagent_type })])`, synthesized `return`), fanned out three real subagents through the shared spawn core, and the tool returned `status: completed, agentCount: 3` with all agents `done`. Structured output, abort propagation, and limiter queueing are covered by unit/faux-integration tests rather than this run. Manual interactive validation is acceptable for the workflow tool.
