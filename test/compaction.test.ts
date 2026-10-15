import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages);
}

function hasTaskNotification(messages: readonly unknown[]): boolean {
  return messages.some((message: any) =>
    message?.role === "custom" && message.customType === "pi-flow-task-notification");
}

describe("compaction while pi-flow tasks are active", () => {
  const { createSession, setContextRoutingResponses, terminalEnvelope, getToolNames } = setupPiSubagentTestHarness();

  it("rejects manual compaction while a synchronous Tool call is active", async () => {
    const { session, registration, sessionManager } = await createSession({
      thinkingLevel: "off",
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 100,
        },
      },
    });
    const childGate = deferred();
    let childStarted = false;

    setContextRoutingResponses(registration, async (context) => {
      const text = contextText(context);
      const isRoot = getToolNames(context).includes("run_agent");
      if (!isRoot) {
        childStarted = true;
        await childGate.promise;
        return fauxAssistantMessage("MANUAL_CHILD_DONE");
      }
      return fauxAssistantMessage("SEED_REPLY");
    });

    await session.prompt(`Seed manual compaction history. ${"x".repeat(400)}`);
    const tool = session.getToolDefinition("run_agent") as any;
    const toolCall = tool.execute(
      "manual-compaction-task",
      { label: "Manual child", prompt: "Wait, then finish." },
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    );
    await waitUntil(() => childStarted);

    const compactResult = await session.compact().then(
      () => ({ completed: true, error: "" }),
      (error: unknown) => ({
        completed: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    childGate.resolve();
    const result = await toolCall;

    expect(compactResult).toEqual({ completed: false, error: "Compaction cancelled" });
    expect(terminalEnvelope(result)).toEqual(expect.objectContaining({
      status: "completed",
      content: "MANUAL_CHILD_DONE",
    }));
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    expect(hasTaskNotification(session.messages)).toBe(false);
  });
});
