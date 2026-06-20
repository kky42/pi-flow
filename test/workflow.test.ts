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
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "../src/workflow/registry.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { loadWorkflowJournal } from "../src/workflow/journal.ts";
import { createStructuredOutputTool, type StructuredOutputCapture } from "../src/workflow/structured-output.ts";

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
    expect(() => parseWorkflowScript(`${META}const now = Date.now; now();`)).toThrow(/deterministic|Date/i);
    expect(() => parseWorkflowScript(`${META}const D = Date; new D();`)).toThrow(/deterministic|Date/i);
    expect(() => parseWorkflowScript(`${META}const { random } = Math; random();`)).toThrow(/deterministic|Math\.random/i);
    expect(() => parseWorkflowScript(`${META}const M = Math; M.random();`)).toThrow(/deterministic|Math\.random/i);
  });

  it("allows deterministic Math aliases", () => {
    expect(() => parseWorkflowScript(`${META}const M = Math; const x = M.max(1, 2); return await agent(String(x));`)).not.toThrow();
  });

  it("allows Date as a deterministic data field name", () => {
    expect(() => parseWorkflowScript(`${META}const schema = { type: 'object', properties: { Date: { type: 'string' } } };\nreturn await agent('x', { schema });`)).not.toThrow();
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

  it("allows idiomatic computed member access (obj[key], arr[i], { [k]: v })", async () => {
    // The node:vm is explicitly not a security boundary (workflow subagents run
    // with full tools), so the former "dynamic code / constructor escape"
    // hardening was dropped. Its unavoidable side effect was banning all computed
    // access with a non-literal key, which broke ordinary data-shaping scripts
    // that models reach for constantly. Those must now parse and run.
    const result = await runWorkflow(
      `${META}const files = ['a', 'b'];\n` +
        `const out = {};\n` +
        `for (let i = 0; i < files.length; i++) {\n` +
        `  const r = await agent('x:' + files[i], { label: 'a' + i });\n` +
        `  out[files[i]] = r;\n` +
        `}\n` +
        `const dyn = { [files[0]]: out[files[0]] };\n` +
        `return { out, dyn, first: out[files[0]] };`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent: echo },
    );
    expect(result.agentCount).toBe(2);
    expect(result.result).toEqual({
      out: { a: "x:a", b: "x:b" },
      dyn: { a: "x:a" },
      first: "x:a",
    });
  });

  it("still rejects nondeterminism reached through computed/aliased forms", () => {
    // Determinism stays enforced even though escape hardening is gone.
    expect(() => parseWorkflowScript(`${META}const r = Math.random();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const d = new Date();`)).toThrow(/deterministic|Date/i);
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
    ).rejects.toThrow(/awaited before the workflow returns|cannot be called after the workflow body has returned/);
    expect(completed).toEqual(["a"]);
  });


  it("defaults subagent_type to general-purpose and passes an explicit type through", async () => {
    const seen: string[] = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      seen.push(call.subagentType);
      return call.label;
    };
    await runWorkflow(
      `${META}await agent('a', { label: 'one' });\nawait agent('b', { label: 'two', subagent_type: 'explorer' });\nreturn null;`,
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

  it("does not treat a successful null agent result as a failed agent", async () => {
    const ended: Array<{ result: unknown; failed?: boolean }> = [];
    const result = await runWorkflow(`${META}return await agent('x', { label: 'nullable' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async () => null,
      onAgentEnd: (event) => ended.push({ result: event.result, failed: event.failed }),
    });
    expect(result.result).toBeNull();
    expect(ended).toEqual([{ result: null, failed: false }]);
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

  it("does not let scripts swallow abort and report success", async () => {
    const controller = new AbortController();
    await expect(
      runWorkflow(`${META}try { await agent('x', { label: 'a' }); } catch { return 'ignored abort'; }`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: async () => {
          controller.abort();
          return "late";
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("terminates an async script worker that stalls after an await", async () => {
    await expect(
      runWorkflow(`${META}await Promise.resolve();\nwhile (true) {}`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
        limits: { workerHeartbeatIntervalMs: 10, workerStallTimeoutMs: 50, abortGraceMs: 10 },
      }),
    ).rejects.toThrow(/stalled/i);
  });

  it("terminates a responsive script worker that stops making workflow progress", async () => {
    await expect(
      runWorkflow(`${META}await new Promise(() => {});`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
        limits: { workerHeartbeatIntervalMs: 10, workerStallTimeoutMs: 1_000, workerIdleTimeoutMs: 50 },
      }),
    ).rejects.toThrow(/no progress/i);
  });

  it("enforces a maximum number of workflow agent calls", async () => {
    await expect(
      runWorkflow(`${META}return await parallel([1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })));`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runAgent: echo,
        limits: { maxAgentCalls: 2 },
      }),
    ).rejects.toThrow(/maximum workflow agent calls/i);
  });

  it("requires workflow limits to be positive integers", async () => {
    await expect(
      runWorkflow(`${META}return await agent('x');`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
        limits: { maxAgentCalls: 0.5 },
      }),
    ).rejects.toThrow(/positive integer/i);
  });

  it("rejects workflow results that cannot be represented as JSON", async () => {
    await expect(
      runWorkflow(`${META}await agent('x', { label: 'a' });\nreturn 1n;`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/JSON-serializable/i);
  });

  it("rejects class instances in workflow results instead of flattening them", async () => {
    await expect(
      runWorkflow(`${META}await agent('x', { label: 'a' });\nclass Box { constructor() { this.value = 1; } }\nreturn new Box();`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/non-plain object Box/i);
  });

  it("rejects class instances returned by subagents instead of flattening them", async () => {
    class Box {
      value = 1;
    }
    const logs: string[] = [];
    const result = await runWorkflow(`${META}return await agent('x', { label: 'a' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: async () => new Box(),
      onLog: (message) => logs.push(message),
    });

    expect(result.result).toBeNull();
    expect(logs.some((line) => /non-plain object Box/i.test(line))).toBe(true);
  });

  it("normalizes JSON-like workflow results to canonical JSON", async () => {
    const result = await runWorkflow(`${META}await agent('x', { label: 'a' });\nreturn { ok: true, omitted: undefined, bad: NaN, list: [undefined, Infinity, 'x'] };`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: echo,
    });
    expect(result.result).toEqual({ ok: true, bad: null, list: [null, null, "x"] });
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

  it("logs agent-result hook failures without aborting sibling work", async () => {
    let completed = 0;
    const logs: string[] = [];
    const result = await runWorkflow(`${META}return await parallel([\n() => agent('fast', { label: 'fast' }),\n() => agent('slow', { label: 'slow' })\n]);`, {
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
      onLog: (message) => logs.push(message),
    });
    expect(result.result).toEqual(["fast", "slow"]);
    expect(completed).toBe(2);
    expect(logs.some((line) => line.includes("journal full"))).toBe(true);
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

  it("does not replay cached failed agent results on resume", async () => {
    const firstRunEvents: any[] = [];
    const script = `${META}const a = await agent('first', { label: 'one' });\nconst b = await agent('second', { label: 'two' });\nreturn [a, b];`;
    await runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async (call) => {
        if (call.label === "two") throw new Error("transient");
        return `${call.prompt}:live1`;
      },
      onAgentResult: (event) => {
        firstRunEvents.push(event);
      },
    });

    const liveLabels: string[] = [];
    const secondRunEvents: any[] = [];
    const second = await runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async (call) => {
        liveLabels.push(call.label);
        return `${call.prompt}:live2`;
      },
      resumeAgentResults: firstRunEvents.map(({ index, fingerprint, result, failed }) => ({ index, fingerprint, result, failed })),
      onAgentResult: (event) => {
        secondRunEvents.push(event);
      },
    });

    expect(second.result).toEqual(["first:live1", "second:live2"]);
    expect(liveLabels).toEqual(["two"]);
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
      `${META}phase('scan');\nawait agent('a', { label: 'ok' });\nawait agent('b', { label: 'boom' });\nreturn null;`,
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

  it("assigns each agent a distinct index even when labels collide", async () => {
    const ended: Array<{ index: number; failed?: boolean }> = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      if (call.prompt === "boom") throw new Error("kaboom");
      return call.label;
    };
    await runWorkflow(
      `${META}await parallel([\n() => agent('ok', { label: 'dup' }),\n() => agent('boom', { label: 'dup' }),\n]);\nreturn null;`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent,
        onAgentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
      },
    );
    // Same label, distinct indices: the UI keys on index so the failure mark lands on the right row.
    expect(ended.map((event) => event.index).sort()).toEqual([1, 2]);
    const byIndex = new Map(ended.map((event) => [event.index, event.failed]));
    expect(byIndex.get(1)).toBe(false);
    expect(byIndex.get(2)).toBe(true);
  });
});

describe("structured output capture", () => {
  it("captures the first successful call and ignores duplicate calls", async () => {
    const capture: StructuredOutputCapture = { value: undefined, called: false, count: 0, duplicateCall: false };
    const tool = createStructuredOutputTool({ type: "object" }, capture) as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; terminate?: boolean }>;
    };

    const first = await tool.execute("c1", { kind: "first" });
    expect(capture.value).toEqual({ kind: "first" });
    expect(capture.called).toBe(true);
    expect(first.terminate).toBe(true);
    expect(first.content[0].text).toContain("received");

    const second = await tool.execute("c2", { kind: "second" });
    expect(capture.value).toEqual({ kind: "first" }); // first wins; not overwritten
    expect(capture.count).toBe(2);
    expect(capture.duplicateCall).toBe(true);
    expect(second.content[0].text).toContain("ignoring duplicate");
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

  it("rejects scriptPath workflows in saved roots when meta.name is not a saved-workflow name", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const workflowsDir = join(agentDir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      const scriptPath = join(workflowsDir, "bad-name.js");
      writeFileSync(scriptPath, workflowScript("Bad Name"));

      const result = loadWorkflowScriptPath(scriptPath, { agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toContain("meta.name must match");
    });
  });

  it("loads a resume journal up to a malformed trailing line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      const runId = "wf_resume_test";
      writeFileSync(
        join(dir, `run-${runId}.jsonl`),
        [
          JSON.stringify({ type: "run_start", runId }),
          JSON.stringify({ type: "agent_result", index: 1, fingerprint: "a", result: "one" }),
          "{ truncated",
          JSON.stringify({ type: "agent_result", index: 2, fingerprint: "b", result: "two" }),
        ].join("\n"),
      );

      const journal = await loadWorkflowJournal(dir, runId);

      expect(journal?.agentResults).toEqual([{ index: 1, fingerprint: "a", result: "one", failed: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow tool rendering", () => {
  const tool = createWorkflowTool({
    getLimiter: () => new ConcurrencyLimiter(4),
    getThinkingLevel: () => "high",
    getSubagentTimeoutMs: () => 0,
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

  it("renders a phase-grouped tree with per-agent marks and counts", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "audit",
      status: "running",
      agentCount: 3,
      phases: ["scan"],
      agents: [
        { index: 1, label: "alpha", subagentType: "explorer", backend: "pi", status: "running" },
        { index: 2, label: "beta", phase: "scan", subagentType: "codex-reviewer", backend: "codex", status: "done" },
        { index: 3, label: "gamma", subagentType: "claude-reviewer", backend: "claude", status: "error" },
      ],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("Workflow(audit)");
    expect(text).toContain("running");
    expect(text).toContain("running · 1/3");
    // scan phase is complete (beta done) -> ✓ header; unphased bucket has a failure.
    expect(text).toContain("✓ scan done · 1/1");
    expect(text).toContain("✓ Codex Agent(codex-reviewer, beta)");
    expect(text).toContain("✗ unphased failed · 0/2");
    expect(text).toContain("Pi Agent(explorer: alpha)");
    expect(text).toContain("✗ Claude Agent(claude-reviewer, gamma)");
    // declared phase renders before the unphased bucket.
    expect(text.indexOf("scan")).toBeLessThan(text.indexOf("unphased"));
  });

  it("shows an entered phase header before its first agent starts", () => {
    const theme = makeMockTheme();
    // phase('scan') has fired but no agent in it has launched yet.
    const details: WorkflowToolDetails = {
      name: "setup",
      status: "running",
      agentCount: 0,
      phases: ["scan"],
      currentPhase: "scan",
      agents: [],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    // Active phase is visible and marked current, not collapsed to the flat list.
    expect(text).toContain("▶ scan running · 0/0");
  });

  it("does not keep the final current phase running after workflow completion", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "done-phase",
      status: "completed",
      agentCount: 1,
      phases: ["review"],
      currentPhase: "review",
      agents: [{ index: 1, label: "review-a", phase: "review", status: "done" }],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("✓ review done · 1/1");
    expect(text).not.toContain("▶ review running · 1/1");
  });

  it("marks failed current phases as failed", () => {
    const theme = makeMockTheme();
    const failedAgent: WorkflowToolDetails = {
      name: "failed-phase",
      status: "running",
      agentCount: 1,
      phases: ["verify"],
      currentPhase: "verify",
      agents: [{ index: 1, label: "verify-a", phase: "verify", status: "error" }],
      logs: [],
    };
    const failedEmpty: WorkflowToolDetails = {
      name: "failed-empty",
      status: "error",
      agentCount: 0,
      phases: ["verify"],
      currentPhase: "verify",
      agents: [],
      logs: [],
      error: "script blew up",
    };
    const failedAgentText = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details: failedAgent }, {}, theme));
    const failedEmptyText = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details: failedEmpty }, {}, theme));
    expect(failedAgentText).toContain("✗ verify failed · 0/1");
    expect(failedEmptyText).toContain("✗ verify failed · 0/0");
  });

  it("shows planned meta phases before they are reached", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "planned",
      status: "running",
      agentCount: 1,
      phases: ["scan"],
      plannedPhases: [{ title: "scan" }, { title: "review" }, { title: "fix" }],
      currentPhase: "scan",
      agents: [{ index: 1, label: "scan-a", phase: "scan", status: "running" }],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("▶ scan running · 0/1");
    expect(text).toContain("· review planned · 0/0");
    expect(text).toContain("· fix planned · 0/0");
    expect(text.indexOf("scan")).toBeLessThan(text.indexOf("review"));
    expect(text.indexOf("review")).toBeLessThan(text.indexOf("fix"));
    expect(text).toContain("Agent(agent: scan-a)");
  });

  it("keeps a flat list when no agent has a phase", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "flat",
      status: "running",
      agentCount: 2,
      phases: [],
      agents: [
        { index: 1, label: "alpha", status: "running" },
        { index: 2, label: "beta", status: "done" },
      ],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("Agent(agent: alpha)");
    expect(text).toContain("✓ Agent(agent, beta)");
    expect(text).not.toContain("unphased");
  });

  it("renders the over-cap flat list with the hidden marker after the visible rows", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "flat",
      status: "running",
      agentCount: 8,
      phases: [],
      agents: Array.from({ length: 8 }, (_, i) => ({
        index: i + 1,
        label: `a${i + 1}`,
        status: "running" as const,
      })),
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    // Earliest agents are shown; the "not shown" marker stands for the later ones
    // and must come after the visible rows.
    expect(text).toContain("Agent(agent, a1)");
    expect(text).toContain("... 2 agent(s) not shown");
    expect(text.indexOf("a1")).toBeLessThan(text.indexOf("not shown"));
    expect(text).not.toContain("a8");
  });

  it("advances the spinner glyph from the snapshot frame counter", () => {
    const theme = makeMockTheme();
    const make = (frame: number): WorkflowToolDetails => ({
      name: "spin",
      status: "running",
      agentCount: 1,
      phases: [],
      frame,
      agents: [{ index: 1, label: "alpha", status: "running" }],
      logs: [],
    });
    // frame 0 -> first braille glyph, frame 1 -> second: proves the runtime
    // heartbeat's frame counter drives the animation, with no UI-side timer.
    const f0 = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details: make(0) }, {}, theme));
    const f1 = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details: make(1) }, {}, theme));
    expect(f0).toContain("⠋ Agent(agent: alpha)");
    expect(f1).toContain("⠙ Agent(agent: alpha)");
  });

  it("keeps rich activity rows when queued backlog exceeds the rich threshold", () => {
    const theme = makeMockTheme();
    const details: WorkflowToolDetails = {
      name: "queued-rich",
      status: "running",
      agentCount: 8,
      phases: [],
      agents: [
        ...Array.from({ length: 4 }, (_, i) => ({
          index: i + 1,
          label: `r${i + 1}`,
          status: "running" as const,
          activity: [`activity-${i + 1}`],
          activityCount: 1,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          index: i + 5,
          label: `q${i + 1}`,
          status: "queued" as const,
        })),
      ],
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("Agent(agent: r1)");
    expect(text).toContain("activity-1");
    expect(text).toContain("◌ Agent(agent, q1) queued");
  });

  it("groups multi-phase (loop-style) waves in declaration order and caps per phase", () => {
    const theme = makeMockTheme();
    const agents = [
      { index: 1, label: "t1", phase: "loop1:opt", status: "done" as const },
      { index: 2, label: "t2", phase: "loop1:opt", status: "done" as const },
      // loop2:opt has 8 agents -> per-phase cap of 6 plus a "... 2 more" line.
      ...Array.from({ length: 8 }, (_, i) => ({
        index: 3 + i,
        label: `u${i + 1}`,
        phase: "loop2:opt",
        status: "running" as const,
      })),
    ];
    const details: WorkflowToolDetails = {
      name: "loop",
      status: "running",
      agentCount: agents.length,
      phases: ["loop1:opt", "loop2:opt"],
      agents,
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("✓ loop1:opt done · 2/2");
    expect(text).toContain("▶ loop2:opt running · 0/8");
    expect(text).toContain("... 2 more");
    expect(text.indexOf("loop1:opt")).toBeLessThan(text.indexOf("loop2:opt"));
  });

  it("shows the earliest agents in an over-cap running wave and hides the rest", () => {
    const theme = makeMockTheme();
    // 12 concurrent agents (the screenshot scenario): the 6-row window must show
    // the earliest indices #1..#6 with "... 6 more" for #7..#12 — not the newest.
    const details: WorkflowToolDetails = {
      name: "ceiling_opt",
      status: "running",
      agentCount: 12,
      phases: ["ceiling optimization workers"],
      agents: Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        label: `t${i + 1}`,
        phase: "ceiling optimization workers",
        status: "running" as const,
      })),
      logs: [],
    };
    const text = renderToText(tool.renderResult({ content: [{ type: "text", text: "x" }], details }, {}, theme));
    expect(text).toContain("Agent(agent, t1)");
    expect(text).toContain("Agent(agent, t6)");
    expect(text).toContain("... 6 more");
    expect(text).not.toContain("t7");
    expect(text).not.toContain("t12");
  });

  it("renders a completed snapshot and surfaces a failure message", () => {
    const theme = makeMockTheme();
    const completed: WorkflowToolDetails = {
      name: "done-flow",
      status: "completed",
      agentCount: 1,
      phases: [],
      agents: [{ index: 1, label: "only", status: "done" }],
      logs: [],
    };
    const completedText = renderToText(
      tool.renderResult({ content: [{ type: "text", text: "x" }], details: completed }, {}, theme),
    );
    expect(completedText).toContain("Workflow(done-flow)");
    expect(completedText).toContain("completed");
    expect(completedText).toContain("completed · 1/1");

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
    const flags = new Map<string, boolean | string>();
    return {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      getFlag: (name: string) => flags.get(name),
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
