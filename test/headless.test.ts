import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../src/types.ts";

const spawn = vi.hoisted(() => vi.fn());
const sdkState = vi.hoisted(() => ({ provider: "configured", model: "model-a", available: [{ provider: "fallback", id: "model-b" }] as object[] }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original()),
  getAgentDir: () => "/tmp/pi-flow-headless-agent",
  AuthStorage: { create: () => ({}) },
  SettingsManager: { create: () => ({
    getDefaultProvider: () => sdkState.provider,
    getDefaultModel: () => sdkState.model,
    getDefaultThinkingLevel: () => "medium",
  }) },
  ModelRegistry: { create: () => ({
    find: (provider: string, model: string) => provider === "configured" && model === "model-a" ? { provider, id: model } : undefined,
    getAvailable: async () => sdkState.available,
  }) },
}));
vi.mock("../src/core/spawn.ts", async (original) => ({ ...(await original()), spawnSubagent: spawn }));
vi.mock("../src/profiles.ts", () => ({
  getSubagentProfiles: () => new Map([
    ["reviewer", { name: "reviewer", description: "review", backend: "codex", model: "gpt-test", thinking: "high" }],
    ["pi-reviewer", { name: "pi-reviewer", description: "review", backend: "pi" }],
  ]),
}));

import { incrementalPiUsage } from "../src/core/spawn.ts";
import { createWorkflowAgentRunner } from "../src/workflow/agent-runner.ts";
import { executeWorkflow } from "../headless.ts";

const profile: SubagentProfile = { name: "reviewer", description: "review", backend: "codex", model: "gpt-test", thinking: "high" };

beforeEach(() => {
  sdkState.provider = "configured";
  sdkState.model = "model-a";
  sdkState.available = [{ provider: "fallback", id: "model-b" }];
  spawn.mockReset();
  spawn.mockImplementation(async (params) => {
    params.onUsage({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 });
    return { content: [], details: { status: "done", result: "ok", usage: {} } };
  });
});

describe("canonical workflow agent runner", () => {
  it("reports only per-call Pi usage for a resumed session", () => {
    expect(incrementalPiUsage(
      { input: 140, output: 25, cacheRead: 60, cacheWrite: 4, cost: 0.9, costKnown: true, latestCacheHitRate: 30 },
      { input: 100, output: 20, cacheRead: 50, cacheWrite: 1, cost: 0.7, costKnown: true },
    )).toEqual({ input: 40, output: 5, cacheRead: 10, cacheWrite: 3, cost: expect.closeTo(0.2), costKnown: true, latestCacheHitRate: 30 });
  });

  it("restores cached session_key bindings before the next live call", async () => {
    const runner = createWorkflowAgentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });
    runner.restoreSessionBinding({
      index: 1, fingerprint: "cached", result: "old", label: "old", prompt: "old",
      subagentType: "reviewer", backend: "codex", sessionKey: "worker", sessionId: "session-1", cached: true,
    });
    await runner.runAgent({ prompt: "continue", label: "lane", subagentType: "reviewer", sessionKey: "worker" }, new AbortController().signal);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", persistSession: true }));
  });

  it("rejects keyed replay when the profile backend changed", async () => {
    const runner = createWorkflowAgentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });
    runner.restoreSessionBinding({
      index: 1, fingerprint: "cached", result: "old", label: "old", prompt: "old",
      subagentType: "reviewer", backend: "pi", sessionKey: "worker", sessionId: "session-1", cached: true,
    });
    await expect(runner.runAgent(
      { prompt: "continue", label: "lane", subagentType: "reviewer", sessionKey: "worker" },
      new AbortController().signal,
    )).rejects.toThrow(/already belongs/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("forwards profile model and thinking to the backend spawn", async () => {
    const runner = createWorkflowAgentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      thinkingLevel: "low", timeoutMs: 123,
    });
    await runner.runAgent({ prompt: "inspect", label: "lane", subagentType: "reviewer" }, new AbortController().signal);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ profile, thinkingLevel: "high", timeoutMs: 123 }));
  });
});

describe("headless workflow", () => {
  it("resolves separate default provider/model settings", async () => {
    await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "model", description: "test" };\nreturn await agent("inspect", { subagent_type: "pi-reviewer" });`,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "configured", id: "model-a" } }));
  });

  it("falls back to the first authenticated model when the configured model is unavailable", async () => {
    sdkState.provider = "missing";
    await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "fallback", description: "test" };\nreturn await agent("inspect", { subagent_type: "pi-reviewer" });`,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "fallback", id: "model-b" } }));
  });

  it("distinguishes caller abort from workflow timeout", async () => {
    spawn.mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })));
    const script = `export const meta = { name: "abort", description: "test" };\nreturn await agent("inspect", { subagent_type: "reviewer" });`;
    const controller = new AbortController();
    const aborted = executeWorkflow({ cwd: process.cwd(), script, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    await expect(executeWorkflow({ cwd: process.cwd(), script, workflowTimeoutMs: 5 })).rejects.toMatchObject({ code: "WORKFLOW_TIMEOUT" });
  });

  it("computes aggregate cache hit rate from cumulative child usage", async () => {
    spawn.mockImplementation(async (params) => {
      const first = params.description === "one";
      params.onUsage(first
        ? { input: 50, output: 1, cacheRead: 50, cacheWrite: 0, cost: 0 }
        : { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 });
      return { content: [], details: { status: "done", result: params.description } };
    });
    const result = await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "cache", description: "test" };\nreturn await parallel([() => agent("a", { label: "one", subagent_type: "reviewer" }), () => agent("b", { label: "two", subagent_type: "reviewer" })]);`,
    });
    expect(result.usage).toMatchObject({ input: 150, cacheRead: 50, latestCacheHitRate: 25 });
  });

  it("runs without an ExtensionContext or UI and reports cumulative usage", async () => {
    const usage: unknown[] = [];
    const result = await executeWorkflow({
      cwd: process.cwd(), allowedBackends: ["codex"], onUsage: (value) => usage.push(value),
      script: `export const meta = { name: "headless", description: "test" };\nreturn await agent("inspect", { subagent_type: "reviewer" });`,
    });
    expect(result.result).toBe("ok");
    expect(result.usage).toMatchObject({ input: 2, output: 3, childAgents: 1, latestCacheHitRate: 0 });
    expect(usage.length).toBeGreaterThan(0);
  });
});
