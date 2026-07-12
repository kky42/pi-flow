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
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
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
          prompt: "This should fail before launch.",
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

    disposeSession(session);
  });


  it("queues foreground parallel Agent calls over maxConcurrentSubagents", async () => {
    const { session, registration } = await createSession({ maxConcurrentSubagents: 1 });
    let rootContinuationContext: Context | undefined;
    let childCallCount = 0;
    let activeChildren = 0;
    let maxActiveChildren = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const childResponse = async () => {
      const index = ++childCallCount;
      activeChildren++;
      maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
      try {
        if (index === 1) {
          firstStarted();
          await firstGate;
          return fauxAssistantMessage("first result");
        }
        return fauxAssistantMessage("second result");
      } finally {
        activeChildren--;
      }
    };

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
      childResponse,
      childResponse,
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("done");
      },
    ]);

    const promptPromise = session.prompt("Run two searches.");
    await firstStartedGate;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(childCallCount).toBe(1);
    expect(maxActiveChildren).toBe(1);

    releaseFirst();
    await promptPromise;

    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("first result");
    expect(serialized).toContain("second result");
    expect(childCallCount).toBe(2);
    expect(maxActiveChildren).toBe(1);

    disposeSession(session);
  });


  it("uses --max-concurrent-subagents flag value over the factory default", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 3, maxConcurrentSubagentsFlag: "1" });
    const tool = session.getToolDefinition("Agent") as any;
    const ctx = makeExecutionContext({ hasUI: false, model, modelRegistry });

    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    registration.setResponses([
      async () => {
        await gate1;
        return fauxAssistantMessage("first flagged result");
      },
      fauxAssistantMessage("second flagged result"),
    ]);

    const inFlight = tool.execute("flag-1", { description: "First", prompt: "First flagged task." }, undefined, undefined, ctx);
    let queuedSettled = false;
    const queued = tool
      .execute("flag-2", { description: "Second", prompt: "Second flagged task." }, undefined, undefined, ctx)
      .then((result: any) => {
        queuedSettled = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queuedSettled).toBe(false);

    release1();
    expect((await inFlight).details.result).toContain("first flagged result");
    expect((await queued).details.result).toContain("second flagged result");

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

    // A third launch while two are genuinely in-flight must queue, not reject.
    let queuedSettled = false;
    const queued = tool.execute("c3", { description: "C", prompt: "Task C." }, undefined, undefined, ctx).then((result: any) => {
      queuedSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queuedSettled).toBe(false);

    // Release one child: its slot transfers to the queued launch.
    release1();
    expect((await inFlight1).details.status).toBe("done");
    const recovered = await queued;
    expect(recovered.details.status).toBe("done");
    expect(recovered.details.result).toContain("recovery child done");

    release2();
    expect((await inFlight2).details.status).toBe("done");

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
    expect(failed.details.status).toBe("aborted");
    expect(failed.details.error).toContain("Aborted while waiting for a concurrency slot");

    // With maxConcurrentSubagents 1, the second launch is only possible if the failed
    // child released its slot via the same finally that releases completed ones.
    const recovered = await tool.execute(
      "recovery-agent-call",
      { description: "Recovery search", prompt: "Second task that succeeds." },
      undefined,
      undefined,
      ctx,
    );
    expect(recovered.details.status).toBe("done");
    expect(recovered.details.error).toBeUndefined();
    expect(recovered.details.result).toContain("recovery child done");

    disposeSession(session);
  });
});
