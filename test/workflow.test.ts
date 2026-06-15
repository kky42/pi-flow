import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import {
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentRunner,
} from "../src/workflow/runtime.ts";

const META = "export const meta = { name: 'wf', description: 'a workflow' };\n";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("parseWorkflowScript", () => {
  it("extracts meta and strips the export from the body", () => {
    const { meta, body } = parseWorkflowScript(`${META}return await agent('hi');`);
    expect(meta).toMatchObject({ name: "wf", description: "a workflow" });
    expect(body).not.toContain("export const meta");
    expect(body).toContain("agent('hi')");
  });

  it("requires the meta export as the first statement", () => {
    expect(() => parseWorkflowScript("const x = 1;\n")).toThrow(/export const meta/);
  });

  it("requires non-empty name and description", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x' };\n")).toThrow(/description/);
    expect(() => parseWorkflowScript("export const meta = { description: 'y' };\n")).toThrow(/name/);
  });

  it("rejects non-deterministic time/random APIs", () => {
    expect(() => parseWorkflowScript(`${META}const t = Date.now();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const r = Math.random();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const d = new Date();`)).toThrow(/deterministic/);
  });

  it("rejects non-literal meta", () => {
    expect(() => parseWorkflowScript("export const meta = buildMeta();\n")).toThrow();
  });
});

describe("runWorkflow", () => {
  const echo: WorkflowAgentRunner = async (call) => call.prompt;

  it("runs a single agent and returns its result", async () => {
    const result = await runWorkflow(`${META}return await agent('hello', { label: 'greet' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: echo,
    });
    expect(result.result).toBe("hello");
    expect(result.meta.name).toBe("wf");
    expect(result.agentCount).toBe(1);
  });

  it("defaults subagent_type to general-purpose and passes an explicit type through", async () => {
    const seen: string[] = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      seen.push(call.subagentType);
      return call.label;
    };
    await runWorkflow(
      `${META}await agent('a', { label: 'one' });\nawait agent('b', { label: 'two', subagent_type: 'explorer' });`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent },
    );
    expect(seen).toEqual(["general-purpose", "explorer"]);
  });

  it("exposes args to the script", async () => {
    const result = await runWorkflow(`${META}return await agent('use ' + args.topic, { label: 'x' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: echo,
      args: { topic: "auth" },
    });
    expect(result.result).toBe("use auth");
  });

  it("caps concurrent agents at the shared limiter max", async () => {
    let current = 0;
    let peak = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      current++;
      peak = Math.max(peak, current);
      await delay(5);
      current--;
      return "done";
    };
    const result = await runWorkflow(
      `${META}return await parallel([1, 2, 3, 4, 5].map((i) => () => agent('t' + i, { label: 'a' + i })));`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(2), runAgent },
    );
    const values = result.result as string[];
    expect(values).toHaveLength(5);
    expect(values.every((value) => value === "done")).toBe(true);
    expect(peak).toBe(2);
    expect(result.agentCount).toBe(5);
  });

  it("pipelines each item through stages while items run concurrently", async () => {
    const upper: WorkflowAgentRunner = async (call) => call.prompt.toUpperCase();
    const result = await runWorkflow(
      `${META}return await pipeline(['a', 'b'], (item) => agent(item, { label: 's1-' + item }), (prev, item) => agent(prev + '-' + item, { label: 's2-' + item }));`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent: upper },
    );
    expect(result.result).toEqual(["A-A", "B-B"]);
  });

  it("returns null and logs when an agent fails", async () => {
    const logs: string[] = [];
    const result = await runWorkflow(`${META}return await agent('x', { label: 'boom' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async () => {
        throw new Error("kaboom");
      },
      onLog: (message) => logs.push(message),
    });
    expect(result.result).toBeNull();
    expect(logs.some((line) => line.includes("boom") && line.includes("kaboom"))).toBe(true);
  });

  it("isolates a failing parallel branch without sinking the others", async () => {
    const runAgent: WorkflowAgentRunner = async (call) => {
      if (call.label === "bad") {
        throw new Error("nope");
      }
      return call.label;
    };
    const result = await runWorkflow(
      `${META}return await parallel([
        () => agent('1', { label: 'ok1' }),
        () => agent('2', { label: 'bad' }),
        () => agent('3', { label: 'ok2' }),
      ]);`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent },
    );
    expect(result.result).toEqual(["ok1", null, "ok2"]);
  });

  it("propagates abort raised mid-run", async () => {
    const controller = new AbortController();
    const runAgent: WorkflowAgentRunner = async () => {
      controller.abort();
      return "late";
    };
    await expect(
      runWorkflow(`${META}return await agent('x', { label: 'a' });`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("requires the result to be structured-cloneable (catches a forgotten await)", async () => {
    await expect(
      runWorkflow(`${META}return { pending: agent('x', { label: 'a' }) };`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/structured-cloneable/);
  });
});

describe("workflow tool registration", () => {
  function fakeApi(names: string[]) {
    return {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      on: () => {},
      getThinkingLevel: () => "high",
    };
  }

  it("registers both Agent and workflow by default", () => {
    const names: string[] = [];
    createSubagentExtension()(fakeApi(names) as never);
    expect(names).toContain("Agent");
    expect(names).toContain("workflow");
  });

  it("omits the workflow tool when workflow is disabled", () => {
    const names: string[] = [];
    createSubagentExtension({ workflow: false })(fakeApi(names) as never);
    expect(names).toEqual(["Agent"]);
  });
});
