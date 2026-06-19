#!/usr/bin/env node
// Complex end-to-end probe for the `workflow` tool. Unlike main-agent-comparison
// (which observes whether the model *chooses* to delegate), this driver pins down
// EVERY workflow feature by handing the model exact scripts to run verbatim and
// asserting on the persisted session details + run journal.
//
// Features covered:
//   - inline `script` source + auto-persistence (scriptPath, runId, journalPath)
//   - meta + phases, log(), phase(), args, cwd globals
//   - parallel() fan-out and pipeline() multi-stage (with originalItem)
//   - structured output via agent({ schema }) -> injected structured_output tool
//   - plain-text agent output contract
//   - concurrency queue-and-drain (fan-out wider than maxConcurrentSubagents)
//   - determinism rejection (Date.now() refused at parse time)
//   - saved-workflow registry via { name } (global ~/.pi/agent/workflows)
//   - resume-by-replay via { scriptPath, resumeFromRunId } (cached prefix)
//
// Usage:
//   node scripts/e2e/workflow-features.mjs --model deepseek/deepseek-v4-flash --thinking high
//   node scripts/e2e/workflow-features.mjs --model openai/gpt-5.4-mini --thinking high --keep
//
// The run uses the caller's real ~/.pi/agent config (so provider/model resolution
// and saved-workflow roots match production). It writes a temp fixture + sessions
// under an OS temp dir and prints PASS/FAIL/INCONCLUSIVE per check.

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(repoRoot, "index.ts");

function parseArgs(argv) {
  const options = {
    model: "deepseek/deepseek-v4-flash",
    thinking: "high",
    sessionRoot: path.join(tmpdir(), `pi-wf-features-${Date.now()}`),
    agentDir: process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--session-root") options.sessionRoot = path.resolve(value());
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--only") options.only = value();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function slug(text) {
  return text.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "model";
}

// ---------------------------------------------------------------------------
// Fixture: a tiny multi-file repo the subagents can actually read.
// ---------------------------------------------------------------------------
function createFixture(root) {
  const fx = path.join(root, "fixture");
  ensureDir(path.join(fx, "src"));
  ensureDir(path.join(fx, "test"));
  ensureDir(path.join(fx, "scripts"));
  const files = {
    "package.json": JSON.stringify(
      {
        name: "widget-cli",
        version: "0.2.0",
        description: "A tiny CLI that formats widget reports.",
        type: "module",
        bin: { widget: "./src/cli.js" },
        scripts: { build: "node scripts/build.js", test: "node --test" },
        dependencies: { kleur: "^4.1.5" },
      },
      null,
      2,
    ),
    "README.md": "# widget-cli\n\nFormats widget reports from a JSON file.\n",
    "src/cli.js":
      'import { formatReport } from "./report.js";\nimport { loadWidgets } from "./store.js";\nconst widgets = loadWidgets(process.argv[2]);\nprocess.stdout.write(formatReport(widgets));\n',
    "src/report.js":
      'import kleur from "kleur";\nexport function formatReport(widgets) {\n  return widgets.map((w) => `${kleur.bold(w.name)}: ${w.score}`).join("\\n") + "\\n";\n}\n',
    "src/store.js":
      'import { readFileSync } from "node:fs";\nexport function loadWidgets(path) {\n  if (!path) return [];\n  return JSON.parse(readFileSync(path, "utf8"));\n}\n',
    "test/report.test.js":
      'import { test } from "node:test";\nimport assert from "node:assert";\nimport { formatReport } from "../src/report.js";\ntest("formats", () => { assert.ok(formatReport([{ name: "a", score: 1 }]).includes("a")); });\n',
    "scripts/build.js": 'console.log("nothing to build");\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(fx, rel), content);
  }
  return fx;
}

// ---------------------------------------------------------------------------
// Embedded workflow scripts handed to the model verbatim. No backticks inside
// (string concatenation only) so they embed cleanly in prompts.
// ---------------------------------------------------------------------------
const KITCHEN_SINK = `export const meta = {
  name: "feature_probe",
  description: "Probe parallel, pipeline, phase, log, args, cwd, structured output, and plain-text agents.",
  phases: [{ title: "collect" }, { title: "refine" }]
};
log("probe-args:" + JSON.stringify(args));
log("probe-cwd:" + cwd);
phase("collect");
const targets = args.files;
const analyzed = await parallel(targets.map(function (f) {
  return function () {
    return agent("Read the file " + f + " in this repository and analyze it. Report the file path and the number of exported symbols.", {
      label: "analyze:" + f,
      phase: "collect",
      schema: { type: "object", required: ["file", "exportCount"], properties: { file: { type: "string" }, exportCount: { type: "number" } } }
    });
  };
}));
phase("refine");
const refined = await pipeline(analyzed,
  function (a, original, i) {
    return agent("In one short sentence, describe what the file " + (a && a.file) + " does. Plain text only, no preamble.", { label: "describe:" + i, phase: "refine" });
  },
  function (sentence, original) {
    return { file: original.file, exportCount: original.exportCount, sentence: String(sentence).trim() };
  }
);
return { repo: args.repo, cwd: cwd, count: refined.length, items: refined };`;

const KITCHEN_SINK_ARGS = { repo: "widget-cli", files: ["src/report.js", "src/store.js"] };

const CONCURRENCY_PROBE = `export const meta = { name: "concurrency_probe", description: "Spawn more agents than the shared concurrency cap to verify queue-and-drain." };
const out = await parallel([0, 1, 2, 3].map(function (n) {
  return function () {
    return agent("Reply with exactly this text and nothing else: token-" + n, { label: "slot:" + n });
  };
}));
return { count: out.filter(function (x) { return x !== null; }).length, tokens: out };`;

const NONDET_PROBE = `export const meta = { name: "nondet_probe", description: "Intentionally nondeterministic; must be rejected before any subagent runs." };
const stamp = Date.now();
const reply = await agent("say hi", { label: "greet" });
return { stamp: stamp, reply: reply };`;

const SAVED_WORKFLOW = `export const meta = { name: "zz_e2e_saved_probe", description: "E2E saved-workflow probe: greet via one subagent and echo a token." };
const reply = await agent("Reply with exactly this text and nothing else: saved-workflow-ok", { label: "greet" });
return { reply: String(reply).trim() };`;

const SAVED_WORKFLOW_NAME = "zz_e2e_saved_probe";

// Control-flow scripts: the script BRANCHES on a structured (schema-validated)
// result, so these test structured output as control flow, not just a return
// type. Branches are gated on an unambiguous fixture fact (does the file import
// kleur?) so the taken branch is deterministic despite model nondeterminism:
//   src/report.js -> imports kleur (true);  src/store.js, src/cli.js -> false.
const BRANCH_PROBE = `export const meta = { name: "branch_probe", description: "Per-file structured boolean gates a conditional deep-dive subagent." };
const files = args.files;
const flags = await parallel(files.map(function (f) {
  return function () {
    return agent("Does the file " + f + " import the 'kleur' package? Answer strictly from its source.", {
      label: "flag:" + f,
      schema: { type: "object", required: ["file", "importsKleur"], properties: { file: { type: "string" }, importsKleur: { type: "boolean" } } }
    });
  };
}));
const deepDived = [];
for (const r of flags) {
  if (r && r.importsKleur === true) {
    const note = await agent("In one short sentence, say what " + r.file + " uses kleur for. Plain text only.", { label: "deep:" + r.file });
    deepDived.push({ file: r.file, note: String(note).trim() });
  }
}
return { flags: flags, deepDived: deepDived.map(function (d) { return d.file; }), deep: deepDived };`;

const GATE_PROBE = `export const meta = { name: "gate_probe", description: "Filter files by a structured boolean; gate or early-exit on the survivor set." };
const files = args.files;
const flags = await parallel(files.map(function (f) {
  return function () {
    return agent("Does " + f + " import the 'kleur' package? Answer strictly from its source.", {
      label: "scan:" + f,
      schema: { type: "object", required: ["file", "importsKleur"], properties: { file: { type: "string" }, importsKleur: { type: "boolean" } } }
    });
  };
}));
const survivors = flags.filter(function (r) { return r && r.importsKleur === true; });
if (survivors.length === 0) {
  log("gate: zero survivors, early exit");
  return { survivors: [], summarized: 0, earlyExit: true };
}
const summaries = await parallel(survivors.map(function (r) {
  return function () { return agent("One short sentence describing " + r.file + ". Plain text only.", { label: "sum:" + r.file }); };
}));
return { survivors: survivors.map(function (r) { return r.file; }), summarized: summaries.filter(Boolean).length, earlyExit: false };`;

const ROUTE_PROBE = `export const meta = { name: "route_probe", description: "Classify a file into an enum, then dispatch to a kind-specific follow-up." };
const target = args.file;
const c = await agent("Classify " + target + " as exactly one of: entry (a CLI entry point, e.g. reads process.argv or is declared as a bin), lib (an imported helper module), or test (a test file). Judge strictly from its source and role.", {
  label: "classify",
  schema: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["entry", "lib", "test"] } } }
});
let follow;
if (c && c.kind === "entry") follow = await agent("List the command-line argument(s) " + target + " reads. Plain text only.", { label: "route:entry" });
else if (c && c.kind === "lib") follow = await agent("Name the function(s) " + target + " exports. Plain text only.", { label: "route:lib" });
else follow = await agent("Name the test runner " + target + " uses. Plain text only.", { label: "route:test" });
return { kind: c && c.kind, follow: String(follow).trim() };`;

// Discoverability: a natural-language task that REQUIRES branching on a typed
// per-file boolean, with NO mention of schema/structured_output. If the model
// reaches for agent({ schema }) on its own, the per-file scan agents return
// objects in the journal; if it hand-parses text, they return strings.
const DISCOVERABILITY_PROMPT = [
  "Use the workflow tool to orchestrate this. For each source file in src/ (src/cli.js, src/report.js, src/store.js),",
  "determine whether the file imports the \"kleur\" package. Then, ONLY for the files that DO import kleur, fan out a",
  "follow-up subagent that explains in one sentence how kleur is used there. Finally return an object listing which",
  "files imported kleur and the follow-up explanations. The script must decide which follow-ups to spawn based on the",
  "per-file import result. Do not change any files.",
].join(" ");

// ---------------------------------------------------------------------------
// pi runner
// ---------------------------------------------------------------------------
// Per-session wall-clock cap. Upstream providers occasionally stall on first
// token; a stuck session must not block the whole suite, so we SIGTERM/SIGKILL
// and let the scenario assert on whatever was persisted (usually nothing -> a
// clean FAIL on "model invoked the workflow tool" rather than a hang).
const DEFAULT_PI_TIMEOUT_MS = 8 * 60 * 1000;

function runPi({ model, thinking, agentDir, cwd, sessionDir, sessionId, prompt, extension, timeoutMs = DEFAULT_PI_TIMEOUT_MS }) {
  ensureDir(sessionDir);
  const promptPath = path.join(sessionDir, "prompt.md");
  writeFileSync(promptPath, `${prompt}\n`);
  const args = [
    "-p",
    "--model",
    model,
    "--thinking",
    thinking,
    "--session-dir",
    sessionDir,
    "--session-id",
    sessionId,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
    "--extension",
    extension,
    `@${promptPath}`,
  ];
  const stdoutPath = path.join(sessionDir, "stdout.txt");
  const stderrPath = path.join(sessionDir, "stderr.txt");
  return new Promise((resolve) => {
    const out = createWriteStream(stdoutPath, { flags: "a" });
    const err = createWriteStream(stderrPath, { flags: "a" });
    const child = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => err.write(c));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out.end();
      err.end();
      if (timedOut) console.log(`    ! pi session timed out after ${Math.round(timeoutMs / 1000)}s (${sessionId})`);
      resolve({ exitCode, stdoutPath, stderrPath, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Session + journal analysis
// ---------------------------------------------------------------------------
function findNewestJsonl(dir) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort();
  return files.at(-1);
}

function readJsonlRecords(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);

function analyzeSession(sessionDir) {
  const file = findNewestJsonl(sessionDir);
  const toolCalls = {};
  let fileEdits = 0;
  const workflowResults = [];
  for (const r of readJsonlRecords(file)) {
    const m = r.message;
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const it of content) {
      if (it?.type === "toolCall" && typeof it.name === "string") {
        toolCalls[it.name] = (toolCalls[it.name] ?? 0) + 1;
        if (EDIT_TOOLS.has(it.name)) fileEdits += 1;
      }
    }
    if (m?.role === "toolResult" && m.toolName === "workflow") {
      workflowResults.push({ details: m.details ?? {}, text: m.content?.[0]?.text ?? "" });
    }
  }
  return { sessionFile: file, toolCalls, fileEdits, workflow: workflowResults.at(-1) };
}

function readJournal(journalPath) {
  if (!journalPath || !existsSync(journalPath)) return undefined;
  const agentResults = [];
  let runComplete;
  let runStart;
  for (const entry of readJsonlRecords(journalPath)) {
    if (entry.type === "run_start") runStart = entry;
    else if (entry.type === "agent_result") agentResults[entry.index - 1] = entry;
    else if (entry.type === "run_complete") runComplete = entry;
  }
  return { runStart, agentResults: agentResults.filter(Boolean), runComplete };
}

// Workflow return value is dropped from persisted details; recover it from the
// tool-result text ("Result:\n<json>") as a fallback to the journal.
function parseResultFromText(text) {
  const marker = "\nResult:\n";
  const idx = text.indexOf(marker);
  if (idx === -1) return undefined;
  try {
    return JSON.parse(text.slice(idx + marker.length));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function inlinePrompt(script, args) {
  return [
    "Use the workflow tool now. Call it with the `script` parameter set to EXACTLY the following JavaScript, verbatim — do not modify it, do not wrap it in markdown fences.",
    args ? `Also set the tool's \`args\` parameter to this JSON value: ${JSON.stringify(args)}` : "",
    "Do not change any files in the repository.",
    "",
    "script:",
    script,
  ]
    .filter(Boolean)
    .join("\n");
}

function savedNamePrompt(name) {
  return [
    `Use the workflow tool to run the saved workflow named "${name}".`,
    `Call the workflow tool with { name: "${name}" } and no other source.`,
    "Then report the result it returns.",
  ].join("\n");
}

function resumePrompt(scriptPath, runId, args) {
  return [
    "Re-run the feature_probe workflow from its persisted script and resume its cached results.",
    "Call the workflow tool with these exact parameters:",
    `- scriptPath: "${scriptPath}"`,
    `- resumeFromRunId: "${runId}"`,
    `- args: ${JSON.stringify(args)}`,
    "Report the result it returns.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
function makeScenario(name) {
  const checks = [];
  return {
    name,
    checks,
    check(label, ok, info = "") {
      checks.push({ label, status: ok ? "PASS" : "FAIL", info });
    },
    soft(label, ok, info = "") {
      checks.push({ label, status: ok ? "PASS" : "INCONCLUSIVE", info });
    },
  };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function scenarioKitchenSink(ctx) {
  const s = makeScenario("kitchen-sink (parallel + pipeline + schema + plain-text + globals + persistence)");
  const sessionDir = path.join(ctx.sessionRoot, "kitchen-sink");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-kitchen`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(KITCHEN_SINK, KITCHEN_SINK_ARGS),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details;
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  s.check("no files were edited", a.fileEdits === 0, `edits=${a.fileEdits}`);
  if (!wf) {
    s.check("workflow result present", false, "no workflow toolResult");
    return { scenario: s };
  }
  s.check("meta.name === feature_probe (script ran verbatim)", wf.name === "feature_probe", `name=${wf.name}`);
  s.check("status === completed", wf.status === "completed", `status=${wf.status} error=${wf.error ?? ""}`);
  s.check("agentCount === 4 (2 parallel + 2 pipeline stage-1)", wf.agentCount === 4, `agentCount=${wf.agentCount}`);
  s.check(
    "phases include collect + refine",
    Array.isArray(wf.phases) && wf.phases.includes("collect") && wf.phases.includes("refine"),
    JSON.stringify(wf.phases),
  );
  const logs = Array.isArray(wf.logs) ? wf.logs : [];
  s.check(
    "log() captured args (probe-args includes repo)",
    logs.some((l) => l.startsWith("probe-args:") && l.includes("widget-cli")),
    logs.find((l) => l.startsWith("probe-args:")) ?? "missing",
  );
  s.check(
    "cwd global is the fixture dir",
    logs.some((l) => l.startsWith("probe-cwd:") && l.includes(path.basename(ctx.fixture))),
    logs.find((l) => l.startsWith("probe-cwd:")) ?? "missing",
  );
  s.check("scriptPath persisted + exists", isNonEmptyString(wf.scriptPath) && existsSync(wf.scriptPath), wf.scriptPath ?? "");
  s.check("runId present", isNonEmptyString(wf.runId), wf.runId ?? "");
  s.check("journalPath persisted + exists", isNonEmptyString(wf.journalPath) && existsSync(wf.journalPath), wf.journalPath ?? "");

  const journal = readJournal(wf.journalPath);
  const collect = (journal?.agentResults ?? []).filter((r) => r.phase === "collect");
  const structuredOk = collect.some(
    (r) => r.result && typeof r.result === "object" && typeof r.result.exportCount === "number",
  );
  s.check("structured output validated + captured (numeric exportCount)", structuredOk, JSON.stringify(collect.map((r) => r.result)));
  const result = journal?.runComplete?.result ?? parseResultFromText(a.workflow?.text ?? "");
  const items = Array.isArray(result?.items) ? result.items : [];
  s.check("pipeline produced items with plain-text sentences", items.length >= 1 && items.every((it) => isNonEmptyString(it.sentence)), JSON.stringify(items));
  s.check("return value synthesized (count matches items)", result?.count === items.length && items.length >= 1, JSON.stringify({ count: result?.count, items: items.length }));

  // Hand the resume scenario what it needs.
  ctx.kitchen = { sessionDir, sessionId: `${ctx.idBase}-kitchen`, scriptPath: wf.scriptPath, runId: wf.runId, result, agentCount: wf.agentCount };
  return { scenario: s };
}

async function scenarioConcurrency(ctx) {
  const s = makeScenario("concurrency queue-and-drain (fan-out 4 under cap 2)");
  const sessionDir = path.join(ctx.sessionRoot, "concurrency");
  // Wrapper extension pins the shared cap to 2 so a 4-wide fan-out must queue.
  const wrapper = path.join(ctx.sessionRoot, "low-concurrency-extension.ts");
  writeFileSync(
    wrapper,
    `import { createSubagentExtension } from ${JSON.stringify(extensionPath)};\nexport default createSubagentExtension({ maxConcurrentSubagents: 2 });\n`,
  );
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-concurrency`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(CONCURRENCY_PROBE, undefined),
    extension: wrapper,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details;
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  if (!wf) {
    s.check("workflow result present", false, "no workflow toolResult");
    return { scenario: s };
  }
  s.check("status === completed", wf.status === "completed", `status=${wf.status} error=${wf.error ?? ""}`);
  s.check("agentCount === 4 (all queued agents drained)", wf.agentCount === 4, `agentCount=${wf.agentCount}`);
  const agents = Array.isArray(wf.agents) ? wf.agents : [];
  s.check("every agent reached done", agents.length === 4 && agents.every((ag) => ag.status === "done"), JSON.stringify(agents.map((ag) => ag.status)));
  const result = readJournal(wf.journalPath)?.runComplete?.result ?? parseResultFromText(a.workflow?.text ?? "");
  s.check("result.count === 4", result?.count === 4, JSON.stringify(result));
  return { scenario: s };
}

async function scenarioDeterminism(ctx) {
  const s = makeScenario("determinism rejection (Date.now() refused at parse)");
  const sessionDir = path.join(ctx.sessionRoot, "determinism");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-determinism`,
    cwd: ctx.fixture,
    prompt: `${inlinePrompt(NONDET_PROBE, undefined)}\n\nIf the tool rejects the script, just report the exact error message it returned.`,
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details;
  if (!wf) {
    s.soft("workflow tool was invoked with the verbatim script", false, "model may have refused to run a nondeterministic script");
    return { scenario: s };
  }
  if (wf.status === "completed") {
    s.soft("script ran verbatim (Date.now preserved)", false, "model likely sanitized Date.now(); cannot assert rejection");
    return { scenario: s };
  }
  s.check("status === error", wf.status === "error", `status=${wf.status}`);
  s.check("error names determinism", /deterministic|Date\.now|Math\.random/i.test(wf.error ?? ""), wf.error ?? "");
  s.check("no subagents ran (agentCount === 0)", (wf.agentCount ?? 0) === 0, `agentCount=${wf.agentCount}`);
  return { scenario: s };
}

async function scenarioSavedName(ctx) {
  const s = makeScenario("saved-workflow registry via { name }");
  const workflowsDir = path.join(ctx.agentDir, "workflows");
  const savedFile = path.join(workflowsDir, `${SAVED_WORKFLOW_NAME}.js`);
  const dirPreexisted = existsSync(workflowsDir);
  const filePreexisted = existsSync(savedFile);
  if (filePreexisted) {
    s.soft("saved-workflow fixture slot is free", false, `refusing to overwrite existing ${savedFile}`);
    return { scenario: s };
  }
  ensureDir(workflowsDir);
  writeFileSync(savedFile, SAVED_WORKFLOW);
  try {
    const sessionDir = path.join(ctx.sessionRoot, "saved-name");
    await runPi({
      ...ctx.run,
      sessionDir,
      sessionId: `${ctx.idBase}-saved`,
      cwd: ctx.fixture,
      prompt: savedNamePrompt(SAVED_WORKFLOW_NAME),
      extension: extensionPath,
    });
    const a = analyzeSession(sessionDir);
    const wf = a.workflow?.details;
    s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
    if (!wf) {
      s.check("workflow result present", false, "no workflow toolResult");
      return { scenario: s };
    }
    s.check("status === completed", wf.status === "completed", `status=${wf.status} error=${wf.error ?? ""}`);
    s.check("source === saved (loaded from registry)", wf.source === "saved", `source=${wf.source}`);
    s.check("name === zz_e2e_saved_probe", wf.name === SAVED_WORKFLOW_NAME, `name=${wf.name}`);
    s.check("agentCount === 1", wf.agentCount === 1, `agentCount=${wf.agentCount}`);
    const result = readJournal(wf.journalPath)?.runComplete?.result ?? parseResultFromText(a.workflow?.text ?? "");
    s.check("result.reply echoes saved-workflow-ok", isNonEmptyString(result?.reply) && result.reply.includes("saved-workflow-ok"), JSON.stringify(result));
    return { scenario: s };
  } finally {
    rmSync(savedFile, { force: true });
    if (!dirPreexisted) rmSync(workflowsDir, { recursive: true, force: true });
  }
}

async function scenarioResume(ctx) {
  const s = makeScenario("resume-by-replay via { scriptPath, resumeFromRunId }");
  if (!ctx.kitchen) {
    s.check("kitchen-sink run available to resume", false, "kitchen-sink scenario did not persist a run");
    return { scenario: s };
  }
  // Continue the SAME session so the persisted scriptPath + journal are in-root.
  const sessionDir = ctx.kitchen.sessionDir;
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: ctx.kitchen.sessionId,
    cwd: ctx.fixture,
    prompt: resumePrompt(ctx.kitchen.scriptPath, ctx.kitchen.runId, KITCHEN_SINK_ARGS),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details; // newest workflow result = the resume run
  s.check("model invoked the workflow tool for resume", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  if (!wf) {
    s.check("resume workflow result present", false, "no workflow toolResult");
    return { scenario: s };
  }
  s.check("status === completed", wf.status === "completed", `status=${wf.status} error=${wf.error ?? ""}`);
  s.check("resumeFromRunId echoed", wf.resumeFromRunId === ctx.kitchen.runId, `resumeFromRunId=${wf.resumeFromRunId}`);
  s.check("agentCount === 4", wf.agentCount === 4, `agentCount=${wf.agentCount}`);
  s.check(
    "cachedAgentCount === 4 (full prefix replayed, 0 new spawns)",
    wf.cachedAgentCount === 4,
    `cachedAgentCount=${wf.cachedAgentCount}`,
  );
  const journal = readJournal(wf.journalPath);
  const cachedAll = (journal?.agentResults ?? []).length === 4 && journal.agentResults.every((r) => r.cached === true);
  s.check("journal marks every agent_result cached", cachedAll, JSON.stringify((journal?.agentResults ?? []).map((r) => r.cached)));
  const replayed = journal?.runComplete?.result ?? parseResultFromText(a.workflow?.text ?? "");
  s.check(
    "replayed result equals original run",
    JSON.stringify(replayed) === JSON.stringify(ctx.kitchen.result),
    `replayed=${JSON.stringify(replayed)?.slice(0, 160)}`,
  );
  return { scenario: s };
}

function journalFor(wf, session) {
  return readJournal(wf.journalPath) ?? { agentResults: [], runComplete: undefined };
}

function resultOf(wf, session) {
  return readJournal(wf.journalPath)?.runComplete?.result ?? parseResultFromText(session.workflow?.text ?? "");
}

// Conditional branch: a structured boolean per file gates a deep-dive subagent.
// Assertions verify the script's control flow is INTERNALLY CONSISTENT with its
// own structured data (branch follows the flags it captured), independent of the
// model's classification accuracy (checked softly).
async function scenarioBranch(ctx) {
  const s = makeScenario("conditional branch on structured output (deep-dive only when flag is true)");
  const sessionDir = path.join(ctx.sessionRoot, "branch");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-branch`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(BRANCH_PROBE, { files: ["src/report.js", "src/store.js"] }),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details;
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  if (!wf) {
    s.check("workflow result present", false, "no workflow toolResult");
    return { scenario: s };
  }
  s.check("status === completed", wf.status === "completed", `status=${wf.status} error=${wf.error ?? ""}`);
  const journal = journalFor(wf, a);
  const labels = journal.agentResults.map((r) => r.label);
  const result = resultOf(wf, a);
  const flags = Array.isArray(result?.flags) ? result.flags : [];
  s.check("per-file results are schema objects with boolean importsKleur", flags.length === 2 && flags.every((f) => f && typeof f.importsKleur === "boolean"), JSON.stringify(flags));
  const expectedDeep = flags.filter((f) => f && f.importsKleur === true).map((f) => f.file);
  const deepDived = Array.isArray(result?.deepDived) ? result.deepDived : [];
  s.check(
    "branch followed the structured flags (deepDived === files flagged true)",
    JSON.stringify([...deepDived].sort()) === JSON.stringify([...expectedDeep].sort()),
    JSON.stringify({ deepDived, expectedDeep }),
  );
  s.check(
    "agentCount === 2 scans + 1-per-true-flag deep-dive",
    wf.agentCount === 2 + expectedDeep.length,
    `agentCount=${wf.agentCount} expected=${2 + expectedDeep.length}`,
  );
  s.check(
    "deep-dive labels exist only for flagged files",
    expectedDeep.every((file) => labels.some((l) => l.startsWith("deep:") && l.includes(path.basename(file)))) &&
      labels.filter((l) => l.startsWith("deep:")).length === expectedDeep.length,
    JSON.stringify(labels),
  );
  const reportFlag = flags.find((f) => String(f?.file).includes("report.js"));
  const storeFlag = flags.find((f) => String(f?.file).includes("store.js"));
  s.soft("model classified the fixture correctly (report=true, store=false)", reportFlag?.importsKleur === true && storeFlag?.importsKleur === false, JSON.stringify({ reportFlag, storeFlag }));
  return { scenario: s };
}

// Filter / gate + zero-count early exit. Run A keeps survivors; run B (a set with
// no kleur importers) must hit the early-return path with no downstream agents.
async function scenarioGate(ctx) {
  const s = makeScenario("filter/gate on structured output + zero-count early exit");

  // Run A: full set -> at least one survivor expected.
  const sessionA = path.join(ctx.sessionRoot, "gate-survivors");
  await runPi({
    ...ctx.run,
    sessionDir: sessionA,
    sessionId: `${ctx.idBase}-gate-a`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(GATE_PROBE, { files: ["src/cli.js", "src/report.js", "src/store.js"] }),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionA);
  const wfA = a.workflow?.details;
  if (!wfA) {
    s.check("[survivors] workflow result present", false, "no workflow toolResult");
  } else {
    s.check("[survivors] status === completed", wfA.status === "completed", `status=${wfA.status} error=${wfA.error ?? ""}`);
    const resA = resultOf(wfA, a);
    const survivors = Array.isArray(resA?.survivors) ? resA.survivors : [];
    s.check(
      "[survivors] gate kept exactly the flagged files; summarized count matches",
      resA?.earlyExit === false && resA?.summarized === survivors.length && survivors.length >= 1,
      JSON.stringify(resA),
    );
    s.check(
      "[survivors] agentCount === 3 scans + 1 per survivor",
      wfA.agentCount === 3 + survivors.length,
      `agentCount=${wfA.agentCount} survivors=${survivors.length}`,
    );
    s.soft("[survivors] survivor set includes report.js", survivors.some((f) => String(f).includes("report.js")), JSON.stringify(survivors));
  }

  // Run B: a single non-kleur file -> early exit, no summary agents.
  const sessionB = path.join(ctx.sessionRoot, "gate-empty");
  await runPi({
    ...ctx.run,
    sessionDir: sessionB,
    sessionId: `${ctx.idBase}-gate-b`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(GATE_PROBE, { files: ["src/store.js"] }),
    extension: extensionPath,
  });
  const b = analyzeSession(sessionB);
  const wfB = b.workflow?.details;
  if (!wfB) {
    s.check("[empty] workflow result present", false, "no workflow toolResult");
  } else {
    s.check("[empty] status === completed", wfB.status === "completed", `status=${wfB.status} error=${wfB.error ?? ""}`);
    const resB = resultOf(wfB, b);
    if (resB?.earlyExit === true) {
      s.check("[empty] early-exit path: 0 summarized, only the scan agent ran", resB.summarized === 0 && wfB.agentCount === 1, JSON.stringify({ res: resB, agentCount: wfB.agentCount }));
      s.check("[empty] log records the early exit", (wfB.logs ?? []).some((l) => l.includes("zero survivors")), JSON.stringify(wfB.logs));
    } else {
      s.soft("[empty] expected zero survivors but model flagged store.js as importing kleur", false, JSON.stringify(resB));
    }
  }
  return { scenario: s };
}

// Route / dispatch: classify into an enum, then switch to a kind-specific agent.
async function scenarioRoute(ctx) {
  const s = makeScenario("route/dispatch on a structured enum");
  const sessionDir = path.join(ctx.sessionRoot, "route");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-route`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(ROUTE_PROBE, { file: "src/cli.js" }),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details;
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  if (!wf) {
    s.check("workflow result present", false, "no workflow toolResult");
    return { scenario: s };
  }
  s.check("status === completed", wf.status === "completed", `status=${wf.status} error=${wf.error ?? ""}`);
  const labels = journalFor(wf, a).agentResults.map((r) => r.label);
  const result = resultOf(wf, a);
  s.check("classified kind is in the enum", ["entry", "lib", "test"].includes(result?.kind), `kind=${result?.kind}`);
  const ranRoutes = labels.filter((l) => l.startsWith("route:"));
  s.check(
    "dispatched to exactly the classified kind (one route taken)",
    ranRoutes.length === 1 && ranRoutes[0] === `route:${result?.kind}`,
    JSON.stringify({ kind: result?.kind, ranRoutes }),
  );
  s.check("agentCount === 2 (classify + one follow-up)", wf.agentCount === 2, `agentCount=${wf.agentCount}`);
  s.soft("classified src/cli.js as entry", result?.kind === "entry", `kind=${result?.kind}`);
  return { scenario: s };
}

// Discoverability: natural language, NO schema hint. Detects whether the model
// reached for agent({ schema }) by checking if per-file decisions came back as
// structured objects (vs hand-parsed text) in the journal. Soft by design.
async function scenarioDiscoverability(ctx) {
  const s = makeScenario("schema discoverability from natural language (no hint)");
  const sessionDir = path.join(ctx.sessionRoot, "discoverability");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-discover`,
    cwd: ctx.fixture,
    prompt: DISCOVERABILITY_PROMPT,
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  const wf = a.workflow?.details;
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  if (!wf || wf.status !== "completed") {
    s.soft("workflow completed", false, `status=${wf?.status ?? "none"} error=${wf?.error ?? ""}`);
    return { scenario: s };
  }
  const agentResults = journalFor(wf, a).agentResults;
  const usedSchema = agentResults.some((r) => r.result && typeof r.result === "object" && !Array.isArray(r.result));
  s.soft(
    "model reached for agent({ schema }) on its own (structured result objects in journal)",
    usedSchema,
    JSON.stringify(agentResults.map((r) => ({ label: r.label, resultType: Array.isArray(r.result) ? "array" : typeof r.result }))),
  );
  return { scenario: s };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function printScenario(result) {
  const { scenario } = result;
  const failed = scenario.checks.filter((c) => c.status === "FAIL").length;
  const inconclusive = scenario.checks.filter((c) => c.status === "INCONCLUSIVE").length;
  const header = failed ? "FAIL" : inconclusive ? "INCONCLUSIVE" : "PASS";
  console.log(`\n[${header}] ${scenario.name}`);
  for (const c of scenario.checks) {
    const info = c.info ? `  (${String(c.info).slice(0, 200)})` : "";
    console.log(`  ${c.status === "PASS" ? "✓" : c.status === "FAIL" ? "✗" : "•"} ${c.label}${info}`);
  }
  return { failed, inconclusive };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/e2e/workflow-features.mjs --model <id> [--thinking high] [--session-root <dir>] [--agent-dir <dir>] [--keep]");
    return;
  }
  ensureDir(options.sessionRoot);
  const fixture = createFixture(options.sessionRoot);
  const ctx = {
    run: { model: options.model, thinking: options.thinking, agentDir: options.agentDir },
    sessionRoot: options.sessionRoot,
    agentDir: options.agentDir,
    fixture,
    idBase: `wff-${slug(options.model)}`,
  };

  console.log(`workflow-features e2e`);
  console.log(`  model:       ${options.model} (thinking=${options.thinking})`);
  console.log(`  extension:   ${extensionPath}`);
  console.log(`  fixture:     ${fixture}`);
  console.log(`  sessionRoot: ${options.sessionRoot}`);
  console.log(`  agentDir:    ${options.agentDir}`);

  // kitchen-sink first (resume depends on its persisted run); rest are independent.
  const registry = [
    ["kitchen", scenarioKitchenSink],
    ["resume", scenarioResume],
    ["branch", scenarioBranch],
    ["gate", scenarioGate],
    ["route", scenarioRoute],
    ["concurrency", scenarioConcurrency],
    ["determinism", scenarioDeterminism],
    ["saved", scenarioSavedName],
    ["discoverability", scenarioDiscoverability],
  ];
  // --only resume implies --only kitchen (resume reuses kitchen's persisted run).
  const want = options.only ? options.only.toLowerCase() : undefined;
  const selected = registry.filter(([key]) => {
    if (!want) return true;
    if (key.includes(want)) return true;
    return want.includes("resume") && key === "kitchen";
  });

  const results = [];
  for (const [, fn] of selected) {
    results.push(await fn(ctx));
  }

  let totalFailed = 0;
  let totalInconclusive = 0;
  for (const r of results) {
    const { failed, inconclusive } = printScenario(r);
    totalFailed += failed;
    totalInconclusive += inconclusive;
  }

  const reportPath = path.join(options.sessionRoot, "report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      { options, scenarios: results.map((r) => ({ name: r.scenario.name, checks: r.scenario.checks })) },
      null,
      2,
    )}\n`,
  );

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `Summary [${options.model}]: ${results.length} scenarios, ${totalFailed} failed check(s), ${totalInconclusive} inconclusive.`,
  );
  console.log(`report=${reportPath}`);
  if (!options.keep) {
    // Keep artifacts only on failure for debugging; clean on green.
    if (totalFailed === 0) rmSync(options.sessionRoot, { recursive: true, force: true });
    else console.log(`(artifacts kept for debugging: ${options.sessionRoot})`);
  }
  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
