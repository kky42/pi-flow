# pi-subagents

Claude Code-style subagents for pi: delegate repo exploration, broad code search, and independent reviews to fresh child agents.

```bash
pi install npm:@kky42/pi-subagents
```

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
