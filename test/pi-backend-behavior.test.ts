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

describe("pi-subagent pi backend behavior", () => {
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
  it("runs a custom read-only subagent with fresh context and an appended role prompt", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-searcher.md"), `---
description: Searches code without editing files.
tools: read, grep, find, ls, bash
---

# Custom Code Searcher Role`);

    const { session, registration } = await createSession();
    let childContext: Context | undefined;
    let childOptions: SimpleStreamOptions | undefined;
    let childModel: Model<string> | undefined;
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Find auth files",
        subagent_type: "code-searcher",
        prompt: "Search for the auth flow and report key files.",
      })], { stopReason: "toolUse" }),
      (context, options, _state, model) => {
        childContext = context;
        childOptions = options;
        childModel = model;
        return fauxAssistantMessage("found auth.ts");
      },
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported to user");
      },
    ]);

    await session.prompt("Please delegate the auth search.");

    expect(childModel?.id).toBe("faux-thinker");
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBe("high");
    expect(childContext?.systemPrompt).toContain("Custom Code Searcher Role");
    expect(childContext?.systemPrompt).not.toContain("Subagent Delegation");
    expect(getToolNames(childContext)).toEqual(["bash", "find", "grep", "ls", "read"]);
    expect(JSON.stringify(childContext?.messages)).toContain("Search for the auth flow");
    expect(JSON.stringify(childContext?.messages)).not.toContain("Please delegate the auth search");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("found auth.ts");

    disposeSession(session);
  });

  it("resumes the child context when session_key is reused", async () => {
    const { session, registration, sessionManager } = await createSession();
    let firstChildContext: Context | undefined;
    let secondChildContext: Context | undefined;
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Initial draft",
        prompt: "Initial draft prompt.",
        session_key: "worker",
      })], { stopReason: "toolUse" }),
      (context) => {
        firstChildContext = context;
        return fauxAssistantMessage("draft v1");
      },
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Revise draft",
        prompt: "Reviewer says tighten the argument.",
        session_key: "worker",
      })], { stopReason: "toolUse" }),
      (context) => {
        secondChildContext = context;
        return fauxAssistantMessage("draft v2");
      },
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Create and revise with the same worker.");

    expect(JSON.stringify(firstChildContext?.messages)).toContain("Initial draft prompt.");
    const resumedMessages = JSON.stringify(secondChildContext?.messages);
    expect(resumedMessages).toContain("Initial draft prompt.");
    expect(resumedMessages).toContain("draft v1");
    expect(resumedMessages).toContain("Reviewer says tighten the argument.");
    expect(resumedMessages).not.toContain("Create and revise with the same worker.");
    const rootMessages = JSON.stringify(rootContinuationContext?.messages);
    expect(rootMessages).not.toContain("session_id:");
    expect(rootMessages).not.toContain("sessionId");
    const mappingEntries = sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "pi-flow-subagent-session-key") as any[];
    expect(mappingEntries).toHaveLength(1);
    expect(mappingEntries[0]?.data).toMatchObject({ key: "worker", subagentType: "general-purpose", backend: "pi" });
    expect(mappingEntries[0]?.data.sessionId).toEqual(expect.any(String));

    disposeSession(session);
  });

  it("preserves discovered append system prompts in child sessions", async () => {
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Project append marker must survive into subagents.");
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "context-checker.md"), `---
description: Checks project context without editing files.
tools: read
---

# Custom Context Checker Role`);

    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Find auth files",
        subagent_type: "context-checker",
        prompt: "Search for the auth flow and report key files.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        return fauxAssistantMessage("found auth.ts");
      },
      fauxAssistantMessage("reported to user"),
    ]);

    await session.prompt("Please delegate the auth search.");

    expect(childContext?.systemPrompt).toContain("Project append marker must survive into subagents.");
    expect(childContext?.systemPrompt).toContain("Custom Context Checker Role");
    expect(childContext?.systemPrompt).not.toContain("Subagent Delegation");

    disposeSession(session);
  });

  it("does not append an extra role prompt for general-purpose subagents", async () => {
    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Research config",
        prompt: "Inspect config loading.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        return fauxAssistantMessage("config found");
      },
      fauxAssistantMessage("done"),
    ]);

    await session.prompt("Delegate config research.");

    expect(childContext?.systemPrompt).not.toContain("Subagent Delegation");
    expect(JSON.stringify(childContext?.messages)).toContain("Inspect config loading.");

    disposeSession(session);
  });


  it("runs a custom subagent with appended body prompt and thinking override", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-reviewer.md"), `---
description: Reviews code changes for correctness.
tools: read, bash
thinking: low
---

Custom reviewer prompt marker.`);

    const { session, registration } = await createSession();
    let childContext: Context | undefined;
    let childOptions: SimpleStreamOptions | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Review changes",
        subagent_type: "code-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      (context, options) => {
        childContext = context;
        childOptions = options;
        return fauxAssistantMessage("review complete");
      },
      fauxAssistantMessage("reported"),
    ]);

    await session.prompt("Delegate code review.");

    expect(childContext?.systemPrompt).toContain("Custom reviewer prompt marker.");
    expect(getToolNames(childContext)).toEqual(["bash", "read"]);
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBe("low");
    expect(JSON.stringify(childContext?.messages)).toContain("Review the latest diff.");

    disposeSession(session);
  });

  it("runs a custom subagent on the valid model named in its profile, not the caller's model", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "fast-agent.md"), `---
description: Runs on the fast model.
model: faux/faux-fast
---

Fast agent prompt marker.`);

    const { session, registration, model: callerModel } = await createSession({
      models: [
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        { id: "faux-fast", name: "Faux Fast", reasoning: false },
      ],
      defaultModelId: "faux-thinker",
    });
    expect(callerModel.id).toBe("faux-thinker");

    const captured = await delegateOnce(session, registration, {
      description: "Fast task",
      subagent_type: "fast-agent",
      prompt: "Do the fast thing.",
    });

    // The child must actually stream on the profile's model (the 4th faux
    // callback arg is the model the session ran with), not the caller's model.
    expect(captured.childModel?.id).toBe("faux-fast");
    expect(captured.childModel?.id).not.toBe(callerModel.id);
    expect(captured.childContext?.systemPrompt).toContain("Fast agent prompt marker.");

    disposeSession(session);
  });

  it("uses the default child-session tools when a subagent profile omits tools", async () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "default-tools.md"), `---
description: Uses the default tool set.
---

Default tools prompt marker.`);

    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Default tools",
        subagent_type: "default-tools",
        prompt: "Inspect the available child-session tools.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        return fauxAssistantMessage("default tools inspected");
      },
      fauxAssistantMessage("reported"),
    ]);

    await session.prompt("Delegate a default-tools subagent.");

    expect(childContext?.systemPrompt).toContain("Default tools prompt marker.");
    expect(getToolNames(childContext)).toEqual(["bash", "edit", "read", "write"]);

    disposeSession(session);
  });


  it("rejects explorer when the user has not defined it as a custom profile", async () => {
    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Find auth files",
        subagent_type: "explorer",
        prompt: "Search for auth.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("saw rejection");
      },
    ]);

    await session.prompt("Delegate with the removed built-in name.");

    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("Unknown subagent_type");
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });


  it("does not expose Agent to subagent sessions", async () => {
    const { session, registration } = await createSession();
    let childContext: Context | undefined;

    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Search",
        prompt: "Report whether the Agent tool is available.",
      })], { stopReason: "toolUse" }),
      (context) => {
        childContext = context;
        const hasAgent = context.tools?.some((tool: { name?: string }) => tool.name === "Agent") ?? false;
        return fauxAssistantMessage(hasAgent ? "Agent visible" : "Agent hidden");
      },
      fauxAssistantMessage("done"),
    ]);

    await session.prompt("Delegate once.");

    expect(childContext?.tools?.some((tool: { name?: string }) => tool.name === "Agent")).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("Agent hidden");
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("does not leak a prior parent tool result into a later child session", async () => {
    const { session, registration } = await createSession();
    let secondChildContext: Context | undefined;

    registration.setResponses([
      // Round 1: the parent delegates, producing an Agent tool result that is
      // appended to the parent conversation.
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "First search", prompt: "First task." })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("FIRST_CHILD_SECRET_RESULT"),
      // Parent continuation: delegate again now that the first tool result is in
      // the parent history.
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Second search", prompt: "Second task." })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        secondChildContext = context;
        return fauxAssistantMessage("second child done");
      },
      fauxAssistantMessage("reported"),
    ]);

    await session.prompt("Delegate twice in sequence.");

    const serialized = JSON.stringify(secondChildContext?.messages);
    expect(serialized).toContain("Second task.");
    // The second child gets a fresh context: no parent user prompt, no earlier
    // delegated prompt, and crucially no earlier child's tool result.
    expect(serialized).not.toContain("FIRST_CHILD_SECRET_RESULT");
    expect(serialized).not.toContain("First task.");
    expect(serialized).not.toContain("Delegate twice in sequence.");

    disposeSession(session);
  });
});
