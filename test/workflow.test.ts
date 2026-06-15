import { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import type { WorkflowToolDetails } from "../src/types.ts";
import {
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentRunner,
} from "../src/workflow/runtime.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";

const META = "export const meta = { name: 'wf', description: 'a workflow' };\n";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMockTheme(): Theme {
  const theme = new Theme({} as never, {} as never, "truecolor");
  (theme as unknown as { fg: (color: string, text: string) => string }).fg = (_color, text) => text;
  (theme as unknown as { bold: (text: string) => string }).bold = (text) => text;
  return theme;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderToText(component: { render: (width: number) => string[] }): string {
  return stripAnsi(component.render(200).join("\n"));
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

  it("emits phase, agent start/end, and failure-log progress events in order", async () => {
    const events: string[] = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      if (call.label === "boom") {
        throw new Error("kaboom");
      }
      return call.label;
    };
    await runWorkflow(
      `${META}phase('scan');\nawait agent('a', { label: 'ok' });\nawait agent('b', { label: 'boom' });`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent,
        onPhase: (title) => events.push(`phase:${title}`),
        onAgentStart: (event) => events.push(`start:${event.label}`),
        onAgentEnd: (event) => events.push(`end:${event.label}:${event.result === null ? "fail" : "ok"}`),
        onLog: () => events.push("log"),
      },
    );
    expect(events).toContain("phase:scan");
    expect(events).toContain("start:ok");
    expect(events).toContain("end:ok:ok");
    expect(events).toContain("start:boom");
    expect(events).toContain("end:boom:fail");
    expect(events).toContain("log");
    expect(events.indexOf("phase:scan")).toBeLessThan(events.indexOf("start:ok"));
    expect(events.indexOf("start:ok")).toBeLessThan(events.indexOf("end:ok:ok"));
  });
});

describe("workflow tool rendering", () => {
  const tool = createWorkflowTool({
    limiter: new ConcurrencyLimiter(4),
    getThinkingLevel: () => "high",
    updateStatus: () => {},
  }) as unknown as {
    renderCall: (args: unknown, theme: Theme, context: { executionStarted: boolean }) => { render: (width: number) => string[] };
    renderResult: (result: unknown, options: unknown, theme: Theme) => { render: (width: number) => string[] };
  };

  it("renders the call label and hides it once execution starts", () => {
    const theme = makeMockTheme();
    const before = renderToText(tool.renderCall({ script: "export const meta = {}" }, theme, { executionStarted: false }));
    expect(before).toContain("Workflow");
    const after = renderToText(tool.renderCall({ script: "..." }, theme, { executionStarted: true }));
    expect(after.trim()).toBe("");
  });

  it("renders a running snapshot with per-agent status marks and counts", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "audit",
      status: "running",
      agentCount: 3,
      phases: ["scan"],
      agents: [
        { label: "alpha", status: "running" },
        { label: "beta", phase: "scan", status: "done" },
        { label: "gamma", status: "error" },
      ],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("Workflow(audit)");
    expect(text).toContain("running");
    expect(text).toContain("1/3 done");
    expect(text).toContain("1 failed");
    expect(text).toContain("• alpha");
    expect(text).toContain("✓ scan / beta");
    expect(text).toContain("✗ gamma");
  });

  it("renders a completed snapshot and surfaces a failure message", () => {
    const theme = makeMockTheme();
    const completed: WorkflowToolDetails = {
      name: "done-flow",
      status: "completed",
      agentCount: 1,
      phases: [],
      agents: [{ label: "only", status: "done" }],
      logs: [],
    };
    const completedText = renderToText(
      tool.renderResult({ content: [{ type: "text", text: "x" }], details: completed }, {}, theme),
    );
    expect(completedText).toContain("Workflow(done-flow)");
    expect(completedText).toContain("completed");
    expect(completedText).toContain("1/1 done");

    const failed: WorkflowToolDetails = {
      name: "broke",
      status: "error",
      agentCount: 0,
      phases: [],
      agents: [],
      logs: [],
      error: "script blew up",
    };
    const failedText = renderToText(
      tool.renderResult({ content: [{ type: "text", text: "x" }], details: failed }, {}, theme),
    );
    expect(failedText).toContain("error");
    expect(failedText).toContain("script blew up");
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
