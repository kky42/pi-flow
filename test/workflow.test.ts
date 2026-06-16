import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { loadSavedWorkflowRegistry } from "../src/workflow/registry.ts";
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
    expect(() => parseWorkflowScript(`${META}const now = Date.now; now();`)).toThrow(/dynamic code|Date/i);
    expect(() => parseWorkflowScript(`${META}const D = Date; new D();`)).toThrow(/dynamic code|Date/i);
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

  it("requires at least one agent call", async () => {
    await expect(
      runWorkflow(`${META}return 'no agents';`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: echo,
      }),
    ).rejects.toThrow(/must call agent/i);
  });

  it("blocks dynamic code generation escape attempts inside the workflow vm", async () => {
    await expect(
      runWorkflow(`${META}log.constructor.constructor('return process')();\nreturn await agent('x');`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: echo,
      }),
    ).rejects.toThrow(/dynamic code|constructor/i);
    await expect(
      runWorkflow(
        `${META}Object.getOwnPropertyDescriptor(Object.getPrototypeOf(log), 'constructor').value('return process')();\nreturn await agent('x');`,
        {
          cwd: "/tmp",
          limiter: new ConcurrencyLimiter(4),
          runAgent: echo,
        },
      ),
    ).rejects.toThrow(/dynamic code|constructor/i);
    await expect(
      runWorkflow(
        `${META}const { constructor: Obj } = globalThis;\nconst { constructor: F } = Obj;\nF('return process')();\nreturn await agent('x');`,
        {
          cwd: "/tmp",
          limiter: new ConcurrencyLimiter(4),
          runAgent: echo,
        },
      ),
    ).rejects.toThrow(/dynamic code|constructor/i);
    await expect(
      runWorkflow(
        `${META}const { getOwnPropertyDescriptor: gopd, getPrototypeOf: gp } = Object;\ngopd(gp(log), 'constructor').value('return process')();\nreturn await agent('x');`,
        {
          cwd: "/tmp",
          limiter: new ConcurrencyLimiter(4),
          runAgent: echo,
        },
      ),
    ).rejects.toThrow(/dynamic code|constructor/i);
  });

  it("waits for started but unawaited agent calls before failing", async () => {
    let completed = false;
    await expect(
      runWorkflow(`${META}agent('slow', { label: 'late' }).then(() => log('late done'));\nreturn 'early';`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async () => {
          await delay(5);
          completed = true;
          return "late";
        },
      }),
    ).rejects.toThrow(/awaited before the workflow returns/);
    expect(completed).toBe(true);
  });

  it("does not allow promise reactions to start new agents after return", async () => {
    const completed: string[] = [];
    await expect(
      runWorkflow(
        `${META}agent('a', { label: 'a' }).then(() => agent('b', { label: 'b' }).then(() => log('b done')));\nreturn 'early';`,
        {
          cwd: "/tmp",
          limiter: new ConcurrencyLimiter(4),
          runAgent: async (call) => {
            completed.push(call.label);
            return call.label;
          },
        },
      ),
    ).rejects.toThrow(/awaited before the workflow returns/);
    expect(completed).toEqual(["a", "b"]);
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

  it("requires every agent call to be awaited or returned", async () => {
    await expect(
      runWorkflow(`${META}return { pending: agent('x', { label: 'a' }) };`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/awaited or returned/);
  });

  it("waits for parallel siblings before surfacing fatal agent-result hook errors", async () => {
    let completed = 0;
    await expect(
      runWorkflow(`${META}return await parallel([\n() => agent('fast', { label: 'fast' }),\n() => agent('slow', { label: 'slow' })\n]);`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async (call) => {
          if (call.label === "slow") await delay(5);
          completed++;
          return call.label;
        },
        onAgentResult: (event) => {
          if (event.label === "fast") {
            throw new Error("journal full");
          }
        },
      }),
    ).rejects.toThrow(/agent-result hook failed/);
    expect(completed).toBe(2);
  });

  it("reuses cached agent results for the longest unchanged prefix on resume", async () => {
    const firstRunEvents: any[] = [];
    const firstRun = await runWorkflow(
      `${META}const a = await agent('first', { label: 'one' });\nconst b = await agent('second', { label: 'two' });\nreturn [a, b];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async (call) => `${call.prompt}:live1`,
        onAgentResult: (event) => {
          firstRunEvents.push(event);
        },
      },
    );
    expect(firstRun.result).toEqual(["first:live1", "second:live1"]);

    const secondRunEvents: any[] = [];
    const livePrompts: string[] = [];
    const secondRun = await runWorkflow(
      `${META}const a = await agent('first', { label: 'one' });\nconst b = await agent('second changed', { label: 'two' });\nreturn [a, b];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async (call) => {
          livePrompts.push(call.prompt);
          return `${call.prompt}:live2`;
        },
        resumeAgentResults: firstRunEvents.map(({ index, fingerprint, result }) => ({ index, fingerprint, result })),
        onAgentResult: (event) => {
          secondRunEvents.push(event);
        },
      },
    );

    expect(secondRun.result).toEqual(["first:live1", "second changed:live2"]);
    expect(livePrompts).toEqual(["second changed"]);
    expect(secondRunEvents.map((event) => event.cached)).toEqual([true, false]);
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

describe("saved workflow registry", () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function workflowScript(name: string, description = "saved workflow"): string {
    return `export const meta = { name: '${name}', description: '${description}' };\nreturn await agent('hello');`;
  }

  it("loads global saved workflows from the agent dir", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      writeFileSync(join(agentDir, "workflows", "audit.js"), workflowScript("audit-todos", "Audit TODOs"));

      const registry = loadSavedWorkflowRegistry({ agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect([...registry.workflows.keys()]).toEqual(["audit-todos"]);
      expect(registry.workflows.get("audit-todos")?.description).toBe("Audit TODOs");
    });
  });

  it("loads project workflows only when the project is trusted and lets project override global", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const cwd = join(dir, "project");
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
      writeFileSync(join(agentDir, "workflows", "review.js"), workflowScript("review", "Global review"));
      writeFileSync(join(cwd, ".pi", "workflows", "review.js"), workflowScript("review", "Project review"));

      const untrusted = loadSavedWorkflowRegistry({ agentDir, cwd, projectTrusted: false });
      expect(untrusted.workflows.get("review")?.description).toBe("Global review");

      const trusted = loadSavedWorkflowRegistry({ agentDir, cwd, projectTrusted: true });
      expect(trusted.workflows.get("review")?.description).toBe("Project review");
      expect(trusted.workflows.get("review")?.scope).toBe("project");
    });
  });

  it("skips invalid workflows and symlinks escaping the workflow root", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const workflowsDir = join(agentDir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, "bad-meta.js"), "export const meta = buildMeta();\n");
      writeFileSync(join(dir, "outside.js"), workflowScript("outside"));
      symlinkSync(join(dir, "outside.js"), join(workflowsDir, "escape.js"));

      const registry = loadSavedWorkflowRegistry({ agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect([...registry.workflows.keys()]).toEqual([]);
      expect(registry.warnings.some((warning) => warning.includes("bad-meta"))).toBe(true);
      expect(registry.warnings.some((warning) => warning.includes("outside") || warning.includes("escape"))).toBe(true);
    });
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
