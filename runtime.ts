/**
 * Headless workflow runtime entry for plain-node (non-pi) consumers.
 *
 * `npm run build:dist` compiles this file and its transitive closure to
 * `dist/`, published as the `@kky42/pi-flow/runtime` export. The pi extension
 * entry (`./index.ts`, loaded by pi's own TS loader) is unaffected.
 *
 * Everything reachable from here must stay runnable on plain node: runtime
 * imports may only be node builtins or regular dependencies (`acorn`). Pi
 * peer packages (`@earendil-works/*`) may appear in type-only imports, which
 * erase at compile time — never as value imports.
 */
export { isWorkflowAbortError, parseWorkflowScript, runWorkflow, WorkflowAbortError } from "./src/workflow/runtime.ts";
export type {
  RunWorkflowOptions,
  WorkflowAgentCall,
  WorkflowAgentResultEvent,
  WorkflowAgentRunner,
  WorkflowCachedAgentResult,
  WorkflowLimits,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunResult,
} from "./src/workflow/runtime.ts";
export { ConcurrencyLimiter } from "./src/core/concurrency.ts";
export type { Release } from "./src/core/concurrency.ts";
