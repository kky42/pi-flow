# pi-subagents

Claude Code-style subagents for pi: delegate repo exploration, broad code search, and independent reviews to fresh child agents.

![pi-subagents screenshot](./assets/subagents.png)

## Pi Subagents vs. Claude Code Subagents

`pi-subagents` brings the same subagent shape to pi: an `Agent` tool with `description`, `prompt`, and optional `subagent_type`.

Available agents:

- `general-purpose`: general agent for complex questions, code search, and multi-step investigations.
- `explorer`: fast read-only search agent for repo maps, file discovery, references, and concise findings.

Fresh subagents start with their own conversation and the same working directory. The parent gets the final subagent report back as a tool result, then synthesizes the answer for the user.

Recent comparison runs:

| Case | Claude Code | pi deepseek-v4-flash |
| --- | --- | --- |
| explore this repo | 1 Agent(Explore) | 1 Agent(explorer) |
| auth multi-repo comparison | 1 Agent | 3 Agent calls |
| migration second opinion | 1 Agent(Explore) | 2 Agent(explorer) calls |
| TODO/FIXME/skipped-test audit | 0 Agent, direct grep | 0 Agent, direct bash |

This is intentionally close to Claude Code's behavior: delegate when a specialized agent helps, and search directly when a simple grep/read path is clearer.

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

This downloads fresh GitHub fixtures (`sindresorhus/ky` and `sindresorhus/got` by default), runs fresh `pi -p` sessions with ambient skills, extensions, prompt templates, themes, and context files disabled, then records Claude Code-style routing scenarios. The default pi settings are `deepseek/deepseek-v4-flash` with `--thinking high`.

- codebase exploration
- review
- simple codebase QA
- small feature implementation
- two-codebase comparison

To compare the same scenarios against Claude Code:

```bash
npm run e2e:compare-claude
```

The Claude comparison uses `--model haiku --effort high` by default. If `DEEPSEEK_API_KEY` is exported or present in `.env`, the runner configures Claude Code with DeepSeek's Anthropic-compatible endpoint and maps `haiku` to `deepseek-v4-flash[1m]`; it also creates a temporary pi auth file for the same key. It writes a report under `/tmp`, shows `MATCH` or `DIFF` for each scenario, and treats timeouts or budget caps in observational scenarios as inconclusive by default. Add `-- --repeat 3` to repeat each task, `-- --strict-observed` when incomplete observational scenarios should fail the command, or `-- --strict-claude` when Claude-side failures should fail the command.
