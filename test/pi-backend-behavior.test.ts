import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness, systemPromptFromProviderContext } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent pi backend behavior", () => {
  let cwd = "";
  let agentDir = "";
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    taskNotifications,
    executeSubagentTask,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    cwd = state.cwd;
    agentDir = state.agentDir;
  });

  it("keeps custom profile prompt, model, thinking, and tools isolated in the child", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "code-searcher.md"), `---
description: Searches code without editing files.
tools: read, grep, find, ls, bash
model: faux/faux-fast
thinking: low
---

Custom Code Searcher Role`);
    const { session, registration, model, modelRegistry } = await createSession({
      models: [
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        { id: "faux-fast", name: "Faux Fast", reasoning: false },
      ],
      defaultModelId: "faux-thinker",
    });
    let childContext: Context | undefined;
    let childOptions: SimpleStreamOptions | undefined;
    let childModel: Model<string> | undefined;

    const { result, terminal } = await executeSubagentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: " Find auth files ", profile: " code-searcher ", prompt: "Search for the auth flow." },
      async (context, options, selectedModel) => {
        childContext = context;
        childOptions = options;
        childModel = selectedModel;
        return fauxAssistantMessage("found auth.ts");
      },
    );

    expect(result.details).toMatchObject({
      status: "done",
      sessionKey: expect.stringMatching(/^session_/),
      label: "Find auth files",
    });
    expect(terminal).toMatchObject({
      task_type: "agent",
      status: "completed",
      session_key: result.details.sessionKey,
      label: "Find auth files",
      content: "found auth.ts",
    });
    expect(taskNotifications(session)).toEqual([]);
    expect(childModel?.id).toBe("faux-fast");
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBeUndefined();
    const childPrompt = systemPromptFromProviderContext(childContext);
    expect(childPrompt).toContain("Custom Code Searcher Role");
    expect(childPrompt).not.toContain("# PiFlow delegation");
    expect(getToolNames(childContext)).toEqual(["bash", "find", "grep", "ls", "read"]);
    expect(JSON.stringify(childContext?.messages)).toContain("Search for the auth flow.");
    disposeSession(session);
  });

  it("preserves project append prompts without exposing delegation tools", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Project append marker.");
    const { session, registration, model, modelRegistry } = await createSession();
    let childContext: Context | undefined;

    await executeSubagentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: "Inspect context", prompt: "Inspect context." },
      async (context) => {
        childContext = context;
        return fauxAssistantMessage("context inspected");
      },
    );

    const appendedPrompt = systemPromptFromProviderContext(childContext);
    expect(appendedPrompt).toContain("Project append marker.");
    expect(appendedPrompt).not.toContain("# PiFlow delegation");
    expect(getToolNames(childContext)).not.toContain("run_agent");
    expect(getToolNames(childContext)).not.toContain("run_workflow");
    disposeSession(session);
  });

  it("generates a session key and resumes it on a later run_agent call", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, sessionManager });
    let secondContext: Context | undefined;
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("run_agent")) return fauxAssistantMessage("root continuation");
      const serialized = JSON.stringify(providerContext.messages);
      if (serialized.includes("Second prompt.")) {
        secondContext = providerContext;
        return fauxAssistantMessage("draft v2");
      }
      return fauxAssistantMessage("draft v1");
    });

    const first = await tool.execute("first", { label: "Initial draft", prompt: "First prompt." }, undefined, undefined, context);
    const firstTerminal = JSON.parse(first.content[0].text);
    const second = await tool.execute(
      "second",
      { label: "Revise draft", prompt: "Second prompt.", session_key: first.details.sessionKey },
      undefined,
      undefined,
      context,
    );
    const secondTerminal = JSON.parse(second.content[0].text);

    expect(first.details.sessionKey).toMatch(/^session_/);
    expect(firstTerminal.session_key).toBe(first.details.sessionKey);
    expect(second.details.sessionKey).toBe(first.details.sessionKey);
    expect(secondTerminal.content).toBe("draft v2");
    const messages = JSON.stringify(secondContext?.messages);
    expect(messages).toContain("First prompt.");
    expect(messages).toContain("draft v1");
    expect(messages).toContain("Second prompt.");
    const mappings = sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "pi-flow-subagent-session-key");
    expect(mappings).toHaveLength(1);
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("fails continuation when the persisted child session is missing", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) =>
      fauxAssistantMessage(getToolNames(providerContext).includes("run_agent") ? "root continuation" : "first done"));

    const first = await tool.execute(
      "first",
      { label: "First", prompt: "First.", session_key: "missing-child" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(first.content[0].text)).toMatchObject({ status: "completed", content: "first done" });
    rmSync(join(agentDir, "subagent-sessions"), { recursive: true, force: true });

    const second = await tool.execute(
      "second",
      { label: "Continue", prompt: "Continue.", session_key: "missing-child" },
      undefined,
      undefined,
      context,
    );
    const terminal = JSON.parse(second.content[0].text);

    expect(second.details.status).toBe("error");
    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("Cannot resume subagent: persisted session");
    expect(terminal.content).toContain("was not found");
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("preserves a caller-supplied new session key", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const { result, terminal } = await executeSubagentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: "Named worker", prompt: "Work.", session_key: "worker" },
      async () => fauxAssistantMessage("worker done"),
    );

    expect(result.details.sessionKey).toBe("worker");
    expect(terminal.session_key).toBe("worker");
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("fails a session key reused with a different profile", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "reviewer.md"), "---\ndescription: Reviewer.\n---\nReviewer role.");
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) =>
      fauxAssistantMessage(getToolNames(providerContext).includes("run_agent") ? "root continuation" : "first done"));

    const first = await tool.execute(
      "first",
      { label: "First", prompt: "First.", session_key: "shared" },
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(first.content[0].text).status).toBe("completed");
    const mismatch = await tool.execute(
      "mismatch",
      { label: "Mismatch", prompt: "Second.", session_key: "shared", profile: "reviewer" },
      undefined,
      undefined,
      context,
    );
    const terminal = JSON.parse(mismatch.content[0].text);

    expect(mismatch.details.status).toBe("error");
    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("already belongs to general-purpose (pi)");
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("returns a provider stop error when the child prompt resolves without a completion", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const { session, registration, model, modelRegistry } = await createSession();
    const { result, terminal } = await executeSubagentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: "Provider failure", prompt: "Trigger the provider failure." },
      async () => fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "rate limit exceeded (429)",
      }),
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "rate limit exceeded (429)",
    });
    expect(terminal).toMatchObject({
      status: "failed",
      content: "rate limit exceeded (429)",
    });
    expect(terminal.session_key).toMatch(/^session_/);
    expect(result.details.sessionKey).toMatch(/^session_/);
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("reports unknown profiles in the synchronous terminal result", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "unknown",
      { label: "Unknown", prompt: "Search.", profile: "explorer" },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = JSON.parse(result.content[0].text);

    expect(result.details.status).toBe("error");
    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("Unknown profile");
    expect(terminal.session_key).toBeUndefined();
    expect(result.details.sessionKey).toBeUndefined();
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("omits the session key when the label is blank", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "blank",
      { label: "   ", prompt: "Search." },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = JSON.parse(result.content[0].text);

    expect(result.details.status).toBe("error");
    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("non-whitespace");
    expect(terminal.session_key).toBeUndefined();
    expect(result.details.sessionKey).toBeUndefined();
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("omits the session key when no model is selected", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "no-model",
      { label: "Search", prompt: "Search." },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model: undefined as never, modelRegistry }),
    );
    const terminal = JSON.parse(result.content[0].text);

    expect(result.details.status).toBe("error");
    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("No model is selected");
    expect(terminal.session_key).toBeUndefined();
    expect(result.details.sessionKey).toBeUndefined();
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("fresh generated keys do not leak one child conversation into another", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let secondContext: Context | undefined;
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("run_agent")) return fauxAssistantMessage("root continuation");
      if (JSON.stringify(providerContext.messages).includes("Second task.")) {
        secondContext = providerContext;
        return fauxAssistantMessage("second done");
      }
      return fauxAssistantMessage("FIRST_CHILD_SECRET");
    });

    const first = await tool.execute("first", { label: "First", prompt: "First task." }, undefined, undefined, context);
    expect(JSON.parse(first.content[0].text).status).toBe("completed");
    const second = await tool.execute("second", { label: "Second", prompt: "Second task." }, undefined, undefined, context);
    expect(JSON.parse(second.content[0].text).status).toBe("completed");

    expect(first.details.sessionKey).not.toBe(second.details.sessionKey);
    const messages = JSON.stringify(secondContext?.messages);
    expect(messages).toContain("Second task.");
    expect(messages).not.toContain("FIRST_CHILD_SECRET");
    expect(messages).not.toContain("First task.");
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });
});
