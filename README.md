# pi-subagents

Claude Code-style subagents for pi: delegate repo exploration, broad code search, and independent reviews to fresh child agents.

```bash
pi install npm:@kky42/pi-subagents
```

![pi-subagents screenshot](./assets/subagents.png)

## Pi Subagents vs. Claude Code Subagents

`pi-subagents` brings the same subagent shape to pi: an `Agent` tool with `description`, `prompt`, and optional `subagent_type`.

Available built-in agents:

- `general-purpose`: general agent for complex questions, code search, and multi-step investigations.
- `explorer`: fast read-only search agent for repo maps, file discovery, references, and concise findings.

Built-ins use the same markdown profile style as custom agents and are bundled under `src/subagents/`. Custom agents can be added as `~/.pi/agent/subagents/<agent-name>.md`. Fresh subagents start with their own conversation and the same working directory. The parent gets the final subagent report back as a tool result, then synthesizes the answer for the user.

Recent comparison run:

✅ means the main agent proactively invoked a root subagent for that scenario. ❌ means no root subagent invocation was observed before completion or the tool-call cap. Both harnesses used DeepSeek V4 Pro: pi ran `deepseek/deepseek-v4-pro` with `--thinking high`; Claude Code `2.1.170` was invoked with `--model sonnet --effort high` against DeepSeek's Anthropic-compatible endpoint, resolving to `deepseek-v4-pro[1m]`.

| Scenario | Size | Claude Code 2.1.170 deepseek-v4-pro[1m] | pi deepseek/deepseek-v4-pro |
| --- | --- | --- | --- |
| Exploration | small, 3 files | ❌ | ✅ |
| Exploration | medium, 34 files | ❌ | ✅ |
| Exploration | large, 213 files | ❌ | ✅ |
| Exploration | huge, 703 files | ❌ | ✅ |
| Understanding / QA | small, 3 files | ❌ | ✅ |
| Understanding / QA | medium, 34 files | ❌ | ❌ |
| Understanding / QA | large, 213 files | ✅ | ✅ |
| Understanding / QA | huge, 703 files | ✅ | ❌ |
| Implementation | small, 3 files | ❌ | ✅ |
| Implementation | medium, 34 files | ❌ | ❌ |
| Implementation | large, 213 files | ❌ | ❌ |
| Implementation | huge, 703 files | ❌ | ✅ |

This table measures only the routing decision: whether the main agent chose to invoke a subagent. It does not score answer quality or task completion. Source report: `/var/folders/xg/zjkd61716j76w0gl6s2vk85r0000gn/T/pi-subagent-main-agent-e2e-1781084243842/report.json`.

## Example

Ask pi:

```text
explore this repo
```

The main agent can launch:

```ts
Agent({
  description: "Explore repo structure",
  subagent_type: "explorer",
  prompt: "Map the project purpose, key directories, important files, scripts, tests, and caveats. Do not edit files."
})
```

The explorer returns a concise repo map, and the main agent relays the useful parts.

## Custom Subagents

Define subagents as markdown files. Built-in definitions live in `src/subagents/general-purpose.md` and `src/subagents/explorer.md`; custom definitions live in `~/.pi/agent/subagents/`. The filename is the subagent name, so `~/.pi/agent/subagents/code-reviewer.md` is selected with `subagent_type: "code-reviewer"`.

```md
---
description: Reviews code changes for correctness and maintainability.
tools: read, grep, find, ls, bash
model: inherit
thinking: high
---

You are a careful code reviewer. Focus on correctness, tests, regressions, and maintainability.
```

Fields:

- `description` is required and is shown in the available-agent roster.
- `tools` is optional; omit it to keep the default child-session tools. When present, it must be a non-empty comma-separated string such as `tools: read, grep, find`; that list becomes the child-session tool allowlist. Tool names can target built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and any custom or extension tools loaded into that child session. Unknown tool names are passed to pi, which may ignore them; `Agent` is always stripped from child sessions.
- `model` is optional; omit it or set `inherit` to use the caller's model; explicit values must use exact `provider/model-id` syntax.
- `thinking` is optional; omit it or set `inherit` to use the caller's thinking level.
- The markdown body is required and is appended to the child agent's system prompt.

Files are ignored when the filename is not a valid lowercase kebab-case agent name, the frontmatter is invalid, `description` is missing, the body is empty, `model` is malformed, `tools` is missing a non-empty comma-separated value after the field is present, or `thinking` is not one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Profiles with syntactically valid but unavailable `model` values are not advertised in the active agent roster.

## Notes

- Subagents cannot launch other subagents; the main agent coordinates follow-up delegation after each result returns.
- Root-level parallel delegation is supported and bounded by the extension.
- Subagents inherit the caller's current model and thinking level unless a custom profile overrides `model` or `thinking`.
- Subagents do not inherit parent conversation messages or tool results, so prompts should be self-contained.
- The TUI footer shows cumulative child-agent usage under the `pi-subagents` status key, for example `pi-subagents ↑47k ↓3.5k R177k CH91.0% $0.429`.
- `explorer` is prompted as read-only; its child session allows `bash` for read-only exploration and verification commands such as `rg` or test scripts, while pi permissions are still controlled by the active pi runtime.

## E2E

Run the main-agent behavior e2e matrix:

```bash
npm run e2e
```

This downloads fresh GitHub fixtures across four size buckets (`octocat/Spoon-Knife`, `chalk/chalk`, `expressjs/express`, and `vuejs/core` by default), runs fresh `pi -p` sessions with ambient skills, extensions, prompt templates, themes, and context files disabled, then records Claude Code-style routing scenarios. The default pi settings are `deepseek/deepseek-v4-flash` with `--thinking high`. For observational scenarios, the runner stops an agent process as soon as a root subagent invocation is detected, because that is enough to record the main-agent delegation decision. It also stops after `--max-tool-calls` root tool calls, defaulting to `50`, so direct runs stay bounded. For pi the subagent signal is the `Agent` tool; for Claude Code this can be `Agent`, `Task`, or an agent-named tool advertised in the stream `init` event, such as `Explore`.

- codebase exploration
- codebase understanding / QA
- small README implementation
- small, medium, large, and huge fixture buckets

To compare the same scenarios against Claude Code:

```bash
npm run e2e:compare-claude
```

The Claude comparison uses `--model haiku --effort high` by default and does not set a Claude budget cap unless `--claude-max-budget-usd` is provided. If `DEEPSEEK_API_KEY` is exported or present in `.env`, the runner configures Claude Code with DeepSeek's Anthropic-compatible endpoint and maps `haiku` to `deepseek-v4-flash[1m]`; it also creates a temporary pi auth file for the same key. It writes a report under `/tmp`, logs each scenario, and prints a ✅/❌ `useSubagent` summary table. By default the Claude run keeps Claude Code's dynamic system prompt sections enabled so subagent routing guidance matches normal Claude Code behavior; add `-- --claude-exclude-dynamic-system-prompt-sections` only when you intentionally want Claude's prompt-cache mode. Add `-- --repeat 3` to repeat each task, `-- --max-tool-calls 20` to lower the direct-run cap, `-- --timeout-ms 120000 --claude-timeout-ms 120000` when you want explicit wall-clock limits, `-- --strict-observed` when incomplete observational scenarios should fail the command, or `-- --strict-claude` when Claude-side failures should fail the command.
