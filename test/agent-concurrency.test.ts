import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { getSubagentProfiles, loadBuiltinSubagentProfiles } from "../src/profiles.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeError, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";
import { packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent agent concurrency", () => {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;
  let registrations: Array<{ unregister: () => void }> = [];

  const {
    trackSession,
    disposeSession,
    createSession,
    delegateOnce,
    makeMockTheme,
    stripAnsi,
    renderToText,
    formatTestTokens,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
    registrations = state.registrations;
  });
  it("does not count an unavailable-profile-model rejection toward maxConcurrentSubagents", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "bad-model-agent.md"), `---
description: Uses an unavailable registered model.
model: ghost/nope
---

This should not be advertised or launched.`);

    const { session, registration } = await createSession({ maxConcurrentSubagents: 1 });
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "Bad model first",
          subagent_type: "bad-model-agent",
          prompt: "This should be rejected before launch.",
        }),
        fauxToolCall("Agent", {
          description: "Valid second",
          prompt: "This valid child should still run.",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("valid child ran"),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    await session.prompt("Run one bad and one good subagent.");

    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("Profile model not found: ghost/nope");
    expect(serialized).toContain("valid child ran");
    expect(serialized).not.toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });


  it("enforces maxConcurrentSubagents for foreground parallel Agent calls", async () => {
    const { session, registration } = await createSession({ maxConcurrentSubagents: 1 });
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "First search",
          prompt: "First search task.",
        }),
        fauxToolCall("Agent", {
          description: "Second search",
          prompt: "Second search task.",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("first result"),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    await session.prompt("Run two searches.");

    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("first result");
    expect(serialized).toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });


  it("uses --max-concurrent-subagents flag value over the factory default", async () => {
    const { session, registration } = await createSession({ maxConcurrentSubagents: 3, maxConcurrentSubagentsFlag: "1" });
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([
        fauxToolCall("Agent", {
          description: "First search",
          prompt: "First flagged task.",
        }),
        fauxToolCall("Agent", {
          description: "Second search",
          prompt: "Second flagged task.",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("first flagged result"),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    await session.prompt("Run two searches with the CLI flag cap.");

    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("first flagged result");
    expect(serialized).toContain("Maximum subagent concurrency reached");
    expect(serialized).toContain("maxConcurrentSubagents: 1");

    disposeSession(session);
  });

  it("frees slots across user turns so a later turn can still delegate under the cap", async () => {
    // With a live in-flight gauge (and no per-turn reset), each turn's child
    // releases its slot on completion, so the next turn delegates under the cap.
    const { session, registration } = await createSession({ maxConcurrentSubagents: 1 });

    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Turn 1 search", prompt: "First task." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("turn 1 child done"),
      fauxAssistantMessage("turn 1 reply"),
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Turn 2 search", prompt: "Second task." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("turn 2 child done"),
      fauxAssistantMessage("turn 2 reply"),
    ]);

    await session.prompt("Turn 1 — please delegate.");
    await session.prompt("Turn 2 — please delegate again.");

    const serialized = JSON.stringify(session.messages);
    expect(serialized).toContain("turn 1 child done");
    expect(serialized).toContain("turn 2 child done");
    expect(serialized).not.toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });

  it("counts live in-flight children, not a per-turn quota", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 2 });
    const tool = session.getToolDefinition("Agent") as any;
    const ctx = makeExecutionContext({ hasUI: false, model, modelRegistry });

    // Two children that stay in-flight until released, plus a recovery response.
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    registration.setResponses([
      async () => {
        await gate1;
        return fauxAssistantMessage("child 1 done");
      },
      async () => {
        await gate2;
        return fauxAssistantMessage("child 2 done");
      },
      fauxAssistantMessage("recovery child done"),
    ]);

    // The slot is taken synchronously before runSubagent's first await, so two
    // un-awaited launches saturate the cap of 2 with both children still running.
    const inFlight1 = tool.execute("c1", { description: "A", prompt: "Task A." }, undefined, undefined, ctx);
    const inFlight2 = tool.execute("c2", { description: "B", prompt: "Task B." }, undefined, undefined, ctx);

    // A third launch while two are genuinely in-flight must be rejected by the
    // live cap — a per-turn quota that reset or only counted completed children
    // would let this through.
    const rejected = await tool.execute("c3", { description: "C", prompt: "Task C." }, undefined, undefined, ctx);
    expect(rejected.details.status).toBe("rejected");
    expect(rejected.details.error).toBe("Maximum subagent concurrency reached");

    // Release one child: its slot frees, so a new launch now succeeds.
    release1();
    expect((await inFlight1).details.status).toBe("completed");
    const recovered = await tool.execute("c4", { description: "D", prompt: "Task D." }, undefined, undefined, ctx);
    expect(recovered.details.status).toBe("completed");
    expect(recovered.details.result).toContain("recovery child done");

    release2();
    expect((await inFlight2).details.status).toBe("completed");

    disposeSession(session);
  });

  it("releases completed subagents before later tool rounds in the same user prompt", async () => {
    const { session, registration } = await createSession({ maxConcurrentSubagents: 4 });

    registration.setResponses([
      fauxAssistantMessage(
        [1, 2, 3, 4].map((index) =>
          fauxToolCall("Agent", { description: `Round 1 search ${index}`, prompt: `First round task ${index}.` }),
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("round 1 child 1 done"),
      fauxAssistantMessage("round 1 child 2 done"),
      fauxAssistantMessage("round 1 child 3 done"),
      fauxAssistantMessage("round 1 child 4 done"),
      fauxAssistantMessage(
        [1, 2, 3, 4].map((index) =>
          fauxToolCall("Agent", { description: `Round 2 search ${index}`, prompt: `Second round task ${index}.` }),
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("round 2 child 1 done"),
      fauxAssistantMessage("round 2 child 2 done"),
      fauxAssistantMessage("round 2 child 3 done"),
      fauxAssistantMessage("round 2 child 4 done"),
      fauxAssistantMessage("root done"),
    ]);

    await session.prompt("Run four searches, then after they finish run four more.");

    const serialized = JSON.stringify(session.messages);
    expect(serialized).toContain("round 1 child 4 done");
    expect(serialized).toContain("round 2 child 4 done");
    expect(serialized).not.toContain("Maximum subagent concurrency reached");

    disposeSession(session);
  });

  it("releases the slot when a child fails so a later delegation still launches", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 1 });
    const tool = session.getToolDefinition("Agent") as any;
    const ctx = makeExecutionContext({ hasUI: false, model, modelRegistry });

    // Drive execute() directly so the failure path is deterministic and the
    // per-turn reset does not mask whether the finally released the slot.
    registration.setResponses([fauxAssistantMessage("recovery child done")]);

    const aborted = new AbortController();
    aborted.abort();
    const failed = await tool.execute(
      "failed-agent-call",
      { description: "Doomed search", prompt: "First task that fails." },
      aborted.signal,
      undefined,
      ctx,
    );
    expect(failed.details.status).toBe("error");
    expect(failed.details.error).toContain("aborted before prompt start");

    // With maxConcurrentSubagents 1, the second launch is only possible if the failed
    // child released its slot via the same finally that releases completed ones.
    const recovered = await tool.execute(
      "recovery-agent-call",
      { description: "Recovery search", prompt: "Second task that succeeds." },
      undefined,
      undefined,
      ctx,
    );
    expect(recovered.details.status).toBe("completed");
    expect(recovered.details.error).toBeUndefined();
    expect(recovered.details.result).toContain("recovery child done");

    disposeSession(session);
  });
});
