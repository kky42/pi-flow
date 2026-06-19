# pi-flow

Multi-backend subagents and dynamic workflow orchestration for [pi](https://github.com/earendil-works/pi).

`pi-flow` gives pi two coordination primitives:

- **`Agent`** — launch one fresh subagent for a scoped task.
- **`workflow`** — run a small trusted JavaScript workflow that fans work out through many subagents, optionally across different agent harnesses.

Supported subagent backends:

- **Pi** child sessions
- **Codex CLI** via `codex exec`
- **Claude Code** via `claude -p`

```bash
pi install npm:@kky42/pi-flow
```

![pi-flow screenshot](./assets/pi-flow.png)

## Why pi-flow?

A single agent harness is good at many tasks, but hard problems often benefit from **parallel context gathering**, **adversarial review**, and **model diversity**. `pi-flow` lets the pi main agent route each lane to the backend that fits best.

```text
                         user request
                             │
                             ▼
                    ┌──────────────────┐
                    │  pi main agent   │
                    │  coordinator     │
                    └───────┬──────────┘
                            │ Agent / workflow
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌────────────────┐
│ Pi subagent   │   │ Codex subagent│   │ Claude subagent│
│ local tools   │   │ codex exec    │   │ claude -p      │
│ cheap summary │   │ broad search  │   │ UI/frontend    │
└───────┬───────┘   └───────┬───────┘   └───────┬────────┘
        └───────────────────┼───────────────────┘
                            ▼
                    ┌──────────────────┐
                    │ synthesis in pi  │
                    └──────────────────┘
```

Use it when you want to:

1. **Add subagents and dynamic workflows to pi.** Delegate repository exploration, broad search, review, and synthesis to fresh isolated child agents.
2. **Mix Pi, Codex, and Claude Code backends.** Different harnesses and models have different tool behavior, prompts, strengths, and blind spots. Combining them can improve adversarial review, idea generation, and complex problem solving.
3. **Scale wide fan-out without losing inspectability.** Large audits and research tasks can be split into many bounded subagent lanes. The extension queues lanes under a shared concurrency cap and surfaces progress in the TUI.
4. **Use each subscription/model where it shines.** Example routing:
   - internet/resource-heavy search → Codex + a fast GPT model
   - frontend or product UI work → Claude Code + Opus/Sonnet
   - local file summarization → Pi + DeepSeek V4 Flash
   - backend implementation → Pi + a stronger coding model

## Workflow shapes

### 1. One-off delegation

Ask pi:

```text
Explore this repo and tell me the important files before we edit anything.
```

The main agent can call:

```ts
Agent({
  description: "Explore repo",
  subagent_type: "explorer",
  prompt: "Map the project purpose, key directories, important files, scripts, tests, and caveats. Do not edit files."
})
```

### 2. Adversarial review

```text
Implement the backend change with Pi, then ask Claude Opus, Codex, and another Pi model to review the diff independently. Merge the findings and only fix confirmed issues.
```

```text
main Pi agent
  ├─ implements change
  ├─ Claude reviewer: frontend/API risk, UX regressions
  ├─ Codex reviewer: broad code search, edge cases
  └─ Pi reviewer: project-local conventions and tests
         ↓
  synthesize disagreements → patch → test
```

### 3. Perspective fusion before building

```text
Run a workflow: have Pi, Codex, and Claude propose different approaches for this migration. Compare tradeoffs and recommend one plan.
```

This is useful when the first obvious solution may be a local optimum. The workflow can collect independent plans before the main agent commits to one.

### 4. Large fan-out audit

```text
Run a workflow to audit TODOs, FIXMEs, skipped tests, risky migrations, and stale docs. Fan out by topic, then synthesize a prioritized report.
```

```text
                 workflow script
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   TODO lane      skipped tests   docs drift
        │              │              │
        └──────────────┼──────────────┘
                       ▼
                 synthesis lane
```

## Built-in agents

`pi-flow` includes two built-in profiles:

- `general-purpose` — general agent for complex questions, code search, and multi-step investigations.
- `explorer` — fast read-only search agent for repo maps, file discovery, references, and concise findings.

Custom profiles live in `~/.pi/agent/subagents/<agent-name>.md`. Fresh subagents start with their own conversation in the same working directory. Parent messages, tool results, and reasoning are **not** inherited, so delegated prompts must be self-contained.

## Dynamic workflows

For fan-out work, ask pi for a **workflow**. The model can write a trusted inline JavaScript script or reuse a saved workflow from disk. The `workflow` tool runs the script, starts real subagents through the same spawn path as `Agent`, and returns a synthesized result.

```text
Run a workflow to inspect this repository from three angles: architecture, tests, and release risk. Use different backends if useful.
```

A workflow script looks like this:

```js
export const meta = { name: "audit", description: "find and summarize tech debt" };

const lanes = ["TODO", "FIXME", "skipped tests"];
const findings = await parallel(
  lanes.map((lane) => () =>
    agent(`Find every ${lane} in this repo. Report file:line.`, {
      subagent_type: "explorer",
      label: `find-${lane}`,
    }),
  ),
);

return await agent(`Summarize these findings:\n${findings.join("\n\n")}`, {
  label: "synthesize",
});
```

Workflow globals:

- `agent(prompt, opts)` — spawn one subagent. `opts`: `label`, `phase`, `subagent_type`, `schema`.
- `parallel(thunks)` — run independent `() => agent(...)` thunks concurrently; results preserve input order.
- `pipeline(items, ...stages)` — run each item through ordered stages while different items progress concurrently.
- `phase(title)`, `log(message)`, `args`, and `cwd`.

Important properties:

- **Real backends.** `subagent_type` selects the profile's configured backend, model, thinking level, prompt, and pi-backend tool allowlist.
- **Structured output.** Pass a JSON Schema as `opts.schema`; `agent()` returns a validated object instead of prose. Pi uses an injected `structured_output` tool, Codex uses `--output-schema`, and Claude Code uses `--json-schema`.
- **Saved workflows.** Global workflows live in `~/.pi/agent/workflows/*.js`; trusted project workflows live in `.pi/workflows/*.js`.
- **Resume-by-replay.** Persisted inline runs return `scriptPath`, `runId`, and `journalPath`. Rerun with `workflow({ scriptPath, resumeFromRunId })` to reuse cached outputs for the unchanged prefix of `agent()` calls.
- **Bounded fan-out.** Normal `Agent` calls and workflow `agent()` calls share one global concurrency cap. Excess subagents queue and drain as slots free.
- **Foreground and inspectable.** A workflow is one blocking tool call. There is no background daemon, polling API, or hidden scheduler.
- **Trusted code.** Workflow scripts run in an isolated worker/VM so pi can detect stalls and abort unresponsive scripts, but this is **not a security sandbox**. Treat saved workflows like trusted extensions.

The workflow tool is enabled by default. Disable it when you only want the `Agent` tool:

```ts
import { createFlowExtension } from "@kky42/pi-flow";

export default createFlowExtension({ workflow: false });
```

`createSubagentExtension` remains exported as a compatibility alias.

## Custom backend profiles

Define subagents as markdown files. Built-ins are bundled under `src/subagents/`; custom profiles live in `~/.pi/agent/subagents/`. The filename is the `subagent_type`, so `~/.pi/agent/subagents/code-reviewer.md` is selected with `subagent_type: "code-reviewer"`.

```md
---
description: Reviews code changes for correctness and maintainability.
backend: pi
tools: read, grep, find, bash
model: inherit
thinking: high
---

You are a careful code reviewer. Focus on correctness, tests, regressions, and maintainability.
```

Fields:

- `description` is required and appears in the available-agent roster.
- `backend` is optional. Omit it or set `pi` for an in-process pi child session. Set `codex` for Codex CLI. Set `claude` for Claude Code.
- `tools` is optional and applies only to `backend: pi`; it becomes the child-session tool allowlist. `Agent` and `workflow` are always stripped from pi-backed child sessions.
- `model` is optional. Use `inherit` for the caller's pi model or the external CLI default; explicit strings are passed to the selected backend.
- `thinking` is optional. Use `inherit` or an explicit effort string supported by the backend.
- The markdown body is appended as the profile prompt: pi system prompt addition, Codex `developer_instructions`, or Claude Code `--append-system-prompt`.

Codex profile:

```md
---
description: Reviews code through Codex CLI.
backend: codex
model: gpt-5.4-mini
thinking: high
---

You are a careful Codex reviewer. Focus on correctness, tests, and edge cases.
```

Claude Code profile:

```md
---
description: Reviews UI and frontend changes through Claude Code.
backend: claude
model: opus
thinking: high
---

You are a careful Claude Code reviewer. Focus on UX, frontend architecture, and regressions.
```

External CLI backends intentionally run in no-approval/yolo mode:

- Codex: `codex exec --json --dangerously-bypass-approvals-and-sandbox -- -`
- Claude Code: `claude -p --output-format stream-json --verbose --no-session-persistence --dangerously-skip-permissions`

Only use external backends in trusted repositories.

## Concurrency and status

The global subagent concurrency cap defaults to `12` and is shared by normal `Agent` calls and workflow `agent()` calls.

At pi launch time:

```bash
pi --max-concurrent-subagents 4
```

In extension code:

```ts
import { createFlowExtension } from "@kky42/pi-flow";

export default createFlowExtension({ maxConcurrentSubagents: 4 });
```

The TUI footer shows cumulative child-agent usage under the `pi-flow` status key, for example:

```text
pi-flow ↑47k ↓3.5k R177k CH91.0% $0.429
```

Codex token usage is parsed from `codex exec --json`; costs are estimated for known OpenAI models and shown as unknown/omitted when no price table matches. Claude token usage and cost are parsed from Claude Code stream-json events when reported.

## Installation in a pi extension setup

For package/extension code:

```ts
import { createFlowExtension } from "@kky42/pi-flow";

export default createFlowExtension();
```

Compatibility exports:

```ts
import { createSubagentExtension } from "@kky42/pi-flow";
```

The old `@kky42/pi-subagents` name should be treated as the pre-rename package name.

## E2E checks

Run the main-agent behavior matrix:

```bash
npm run e2e
```

Run workflow feature smoke checks:

```bash
npm run e2e:workflow-features
```

Run external-backend smoke checks:

```bash
npm run e2e:codex-subagent
npm run e2e:claude-subagent
```

Compare routing behavior against Claude Code:

```bash
npm run e2e:compare-claude
```

The e2e scripts use fresh temporary fixtures and isolated pi sessions. Some scenarios are observational: they record whether the main agent chooses to delegate or use `workflow`, not whether every answer is globally optimal.
