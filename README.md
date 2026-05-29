# pi-subagent

Lightweight Claude Code-style subagent extension for pi.

## v1 Scope

This package registers a single `Agent` tool:

```ts
Agent({
  description: "Branch ship-readiness audit",
  subagent_type: "explorer",
  prompt: "Audit what's left before this branch can ship..."
})
```

`subagent_type` is optional and defaults to `general-purpose`.

Available presets:

- `general-purpose` - fresh normal pi agent, no extra role prompt.
- `explorer` - appends a Claude Code Explore-style read-only role prompt. Tool restrictions are not enforced in v1.

V1 is foreground-only: no background tasks, result polling, resume, steering, model override, thinking override, permissions, or user-defined agents.

Nested subagents are allowed with default limits `maxDepth = 2` and `maxWidth = 4`. These limits can be changed by embedding code through `createSubagentExtension({ maxDepth, maxWidth })`; there are no user-facing flags in v1.

The model-facing prompt only says delegation is bounded. Exact depth/width values are enforced by the extension and surfaced through Agent tool rejections when exceeded.

## Usage

Load directly during development:

```bash
pi -e .
```

Or as a package, pi discovers the extension from:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Development

```bash
npm install
npm run check
```

## Verification

Real interactive TUI E2E runs were executed in tmux with:

```bash
--model deepseek/deepseek-v4-flash --thinking high
```

Artifacts live under `/tmp/pi-subagent-e2e`.

Covered:

- `depth-rerun`: `maxDepth=4`; nested Agent chain reached depth 4 and the leaf found `parseSession`.
- `width`: `maxWidth=8`; eight foreground `explorer` Agent calls completed with no rejections.
- `proactive-multirepo-v3`: human-style repo-a/repo-b auth comparison; main agent launched two `explorer` subagents.
- `proactive-fanout-v3`: human-style TODO/FIXME/skipped-test audit; main agent launched three `explorer` subagents.
- `proactive-migration-v2`: human-style migration second opinion; main agent launched a `general-purpose` subagent.

Observed limitation: on a tiny ship-readiness fixture, the model sometimes handles the audit directly instead of delegating. The proactive behavior is therefore verified for broad/parallel/second-opinion tasks, not guaranteed for every small multi-file task.
