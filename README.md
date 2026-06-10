# pi-subagents

Claude Code-style subagents for pi: delegate repo exploration, broad code search, and independent reviews to fresh child agents.

![pi-subagents screenshot](./assets/subagents.png)

## Pi Subagents vs. Claude Code Subagents

`pi-subagents` brings the same subagent shape to pi: an `Agent` tool with `description`, `prompt`, and optional `subagent_type`.

Available agents:

- `general-purpose`: general agent for complex questions, code search, and multi-step investigations.
- `explorer`: fast read-only search agent for repo maps, file discovery, references, and concise findings.

Fresh subagents start with their own conversation and the same working directory. The parent gets the final subagent report back as a tool result, then synthesizes the answer for the user.

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

## Install

Install from pi:

```bash
pi install npm:@kky42/pi-subagents
```

Then run pi normally. The extension registers an `Agent` tool automatically.

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

## Notes

- Subagents cannot launch other subagents; the main agent coordinates follow-up delegation after each result returns.
- Root-level parallel delegation is supported and bounded by the extension.
- Subagents inherit the caller's current model and thinking level.
- Subagents do not inherit parent conversation messages or tool results, so prompts should be self-contained.
- `explorer` is prompted as read-only; pi permissions are still controlled by the active pi runtime.

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
