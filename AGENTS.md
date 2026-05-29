# Agent Notes

## pi-subagent v1 Contract

- This repo implements a lightweight pi extension, not a fork of `refs/pi-subagents`.
- The registered tool is `Agent`.
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
- Nested subagents are allowed. Defaults: `maxDepth = 2`, `maxWidth = 4`.
- Do not put exact depth/width values in the model-facing coordinator prompt. The prompt should say delegation is bounded; enforcement and exact rejection messages come from the tool.
- No user-facing flags in v1. Limit overrides are only through `createSubagentExtension({ maxDepth, maxWidth })`.
- User-defined agents are future work. The main-agent prompt may mention that they are not supported yet.

## References Read

- `refs/pi` for pi extension and SDK APIs.
- `refs/pi-subagents` for a broader Claude Code-style implementation.
- `refs/claude-code-system-prompts` for Agent tool guidance and built-in agent prompts.
- Official Claude Code subagent docs: https://code.claude.com/docs/en/sub-agents

## E2E Evidence

Interactive tmux TUI runs use `deepseek/deepseek-v4-flash` with high thinking and isolated `--no-*` resource flags.

- `depth-rerun`: validates nested foreground delegation through depth 4.
- `width`: validates eight parallel foreground `explorer` delegations.
- `proactive-multirepo-v3`: validates proactive parallel delegation for a two-repo auth comparison.
- `proactive-fanout-v3`: validates proactive multi-lane delegation for TODO/FIXME/skipped-test search.
- `proactive-migration-v2`: validates proactive second-opinion delegation for a risky migration review.

Do not count `proactive-ship-v3` as proactive-pass evidence: the model handled that tiny ship-readiness fixture directly. This is acceptable as a behavioral limitation, but future prompt/tool tuning should continue improving this case.
