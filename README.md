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

| Case | Claude haiku | pi deepseek-v4-flash |
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

- Nested delegation is supported and bounded by the extension.
- Subagents inherit the caller's current model and thinking level.
- Subagents do not inherit parent conversation messages or tool results, so prompts should be self-contained.
- `explorer` is prompted as read-only; pi permissions are still controlled by the active pi runtime.
