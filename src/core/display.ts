import type { SubagentBackend } from "../types.ts";

export function getBackendAgentLabel(backend: SubagentBackend | undefined): string {
  if (backend === "pi") {
    return "Pi Agent";
  }
  if (backend === "codex") {
    return "Codex Agent";
  }
  if (backend === "claude") {
    return "Claude Agent";
  }
  return "Agent";
}
