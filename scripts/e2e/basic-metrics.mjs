#!/usr/bin/env node
// Basic real-model telemetry matrix for the three harnesses supported by pi-flow.
//
// This intentionally invokes Claude Code, Codex, and Pi directly. It validates
// their real JSON streams against pi-flow's production usage parsers and
// formatter without adding a separate root-agent delegation call.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_CLAUDE_MODELS,
  loadDotEnv,
  prepareDeepseekClaudeE2EEnv,
} from "./lib/deepseek-claude-env.mjs";
import {
  BASIC_METRICS_ROWS,
  buildProbeInvocation,
  parseJsonLines,
  summarizeProbe,
} from "./lib/basic-metrics.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;

loadDotEnv(path.join(repoRoot, ".env"));

function parseArgs(argv) {
  const options = {
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    runRoot: path.join(tmpdir(), `pi-flow-basic-metrics-e2e-${Date.now()}`),
    timeoutMs: 300_000,
    keep: false,
    only: undefined,
    piCommand: process.env.PI_E2E_COMMAND || path.join(path.dirname(process.execPath), "pi"),
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = value();
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--only") options.only = value().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--pi-command") options.piCommand = value();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (!existsSync(options.piCommand)) options.piCommand = "pi";
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/e2e/basic-metrics.mjs [options]

Runs a five-row real-model semi-E2E matrix and validates process completion,
model selection, read-tool activity, result tokens, input/output/cache tokens,
cache-hit rate, cost state, and the unified pi-flow usage display.

Options:
  --only <id,...>                run selected row ids only
  --list                         list row ids without invoking models
  --timeout-ms <ms>              timeout per row (default: 300000)
  --pi-command <path>            installed Pi executable (default: beside node)
  --deepseek-api-key-env <name>  preferred DeepSeek credential env var
  --run-root <dir>               artifact root (default: OS temp directory)
  --keep                         keep artifacts after a passing run
  -h, --help                     show this help
`);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function commandVersion(command, env) {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || result.stderr.trim() || undefined;
}

function writeFixture(rowDir, expectedToken) {
  const fixtureDir = path.join(rowDir, "fixture");
  ensureDir(fixtureDir);
  writeFileSync(path.join(fixtureDir, "e2e-target.txt"), `${expectedToken}\n`, "utf8");
  writeFileSync(
    path.join(fixtureDir, "README.md"),
    "# Basic metrics semi-E2E\n\nThe agent must read e2e-target.txt and return its exact content.\n",
    "utf8",
  );
  const init = spawnSync("git", ["init", "-q"], { cwd: fixtureDir, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  spawnSync("git", ["add", "."], { cwd: fixtureDir, encoding: "utf8" });
  const commit = spawnSync(
    "git",
    ["-c", "user.name=pi-flow-e2e", "-c", "user.email=pi-flow-e2e@example.invalid", "commit", "-qm", "fixture"],
    { cwd: fixtureDir, encoding: "utf8" },
  );
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return fixtureDir;
}

function buildPrompt() {
  return [
    "Use the available file-reading tool to read e2e-target.txt in the current working directory.",
    "Do not modify any file and do not infer the file content from this prompt.",
    "After reading it, reply with exactly the file content without quotes, markdown, or additional text.",
  ].join("\n");
}

function runProcess({ command, args, cwd, env, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let captureError;
    let spawnError;
    const append = (current, chunk, streamName) => {
      const next = current + String(chunk);
      if (next.length > MAX_CAPTURE_CHARS && !captureError) {
        captureError = `${streamName} exceeded ${MAX_CAPTURE_CHARS} captured characters`;
        child.kill("SIGTERM");
      }
      return next.slice(0, MAX_CAPTURE_CHARS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => { spawnError = error.message; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        captureError,
        spawnError,
      });
    });
    child.stdin.end(prompt);
  });
}

function appendFailure(summary, message) {
  summary.errors.push(message);
  summary.status = "fail";
}

function printSummary(summary) {
  const marker = summary.status === "pass" ? "PASS" : summary.status === "warn" ? "WARN" : "FAIL";
  const seconds = (summary.durationMs / 1000).toFixed(1);
  const models = summary.observedModels.length > 0 ? summary.observedModels.join(",") : "missing";
  console.log(
    `[${marker}] ${summary.agent} | ${summary.model} | ${summary.thinking} | ${seconds}s | ` +
    `tools=${summary.toolCalls} | ${summary.usageDisplay || "usage missing"} | observed=${models}`,
  );
  for (const warning of summary.warnings) console.log(`  WARN: ${warning}`);
  for (const error of summary.errors) console.log(`  ERROR: ${error}`);
  console.log(`METRICS ${JSON.stringify(summary)}`);
}

async function runRow(row, options, env, versions) {
  const rowDir = path.join(options.runRoot, row.id);
  ensureDir(rowDir);
  const cwd = writeFixture(rowDir, row.expectedToken);
  const invocation = buildProbeInvocation(row);
  if (row.agent === "pi") invocation.command = options.piCommand;
  writeFileSync(path.join(rowDir, "invocation.json"), JSON.stringify({ row, invocation }, null, 2), "utf8");

  console.log(`\nRunning ${row.id}: ${invocation.command} ${invocation.args.join(" ")}`);
  const processResult = await runProcess({
    ...invocation,
    cwd,
    env,
    prompt: buildPrompt(),
    timeoutMs: options.timeoutMs,
  });
  writeFileSync(path.join(rowDir, "stdout.jsonl"), processResult.stdout, "utf8");
  writeFileSync(path.join(rowDir, "stderr.log"), processResult.stderr, "utf8");

  const parsed = parseJsonLines(processResult.stdout);
  const summary = summarizeProbe({
    row,
    events: parsed.events,
    durationMs: processResult.durationMs,
    processResult,
  });
  summary.agentVersion = versions[row.agent];
  summary.artifactDir = rowDir;
  if (parsed.malformedLines.length > 0) {
    appendFailure(summary, `stdout contained ${parsed.malformedLines.length} malformed JSONL line(s)`);
  }
  if (processResult.captureError) appendFailure(summary, processResult.captureError);
  if (processResult.spawnError) appendFailure(summary, `spawn failed: ${processResult.spawnError}`);

  const gitStatus = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  if (gitStatus.status !== 0) appendFailure(summary, `git status failed: ${gitStatus.stderr.trim()}`);
  else if (gitStatus.stdout.trim()) appendFailure(summary, `fixture was modified: ${gitStatus.stdout.trim()}`);

  writeFileSync(path.join(rowDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  printSummary(summary);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.list) {
    for (const row of BASIC_METRICS_ROWS) console.log(`${row.id}\t${row.agent}\t${row.model}\t${row.thinking}`);
    return;
  }

  const selectedIds = new Set(options.only ?? BASIC_METRICS_ROWS.map((row) => row.id));
  const unknownIds = [...selectedIds].filter((id) => !BASIC_METRICS_ROWS.some((row) => row.id === id));
  if (unknownIds.length > 0) throw new Error(`Unknown --only row id(s): ${unknownIds.join(", ")}`);
  const rows = BASIC_METRICS_ROWS.filter((row) => selectedIds.has(row.id));
  ensureDir(options.runRoot);

  const env = prepareDeepseekClaudeE2EEnv(process.env, {
    apiKeyEnv: options.deepseekApiKeyEnv,
    runtimeDir: path.join(options.runRoot, "claude-runtime"),
  });
  env.PI_SKIP_VERSION_CHECK = "1";
  const versions = {
    "claude-code": commandVersion("claude", env),
    codex: commandVersion("codex", env),
    pi: commandVersion(options.piCommand, env),
  };

  console.log(`Artifact root: ${options.runRoot}`);
  console.log(`Claude Code provider: DeepSeek (${DEEPSEEK_ANTHROPIC_BASE_URL})`);
  console.log(`Claude model mapping: haiku -> ${DEEPSEEK_CLAUDE_MODELS.haiku}`);
  console.log(`Versions: ${JSON.stringify(versions)}`);

  let failed = true;
  try {
    const summaries = [];
    for (const row of rows) summaries.push(await runRow(row, options, env, versions));
    failed = summaries.some((summary) => summary.status === "fail");
    const report = {
      status: failed ? "fail" : summaries.some((summary) => summary.status === "warn") ? "warn" : "pass",
      generatedAt: new Date().toISOString(),
      versions,
      rows: summaries,
    };
    writeFileSync(path.join(options.runRoot, "report.json"), JSON.stringify(report, null, 2), "utf8");

    console.log("\nSummary");
    for (const summary of summaries) printSummary(summary);
    if (failed) throw new Error(`basic metrics semi-E2E failed; artifacts kept at ${options.runRoot}`);
    console.log(`PASS basic metrics semi-E2E (${summaries.length} row(s))`);
  } finally {
    if (!failed && !options.keep) rmSync(options.runRoot, { recursive: true, force: true });
    else console.log(`Artifacts kept at: ${options.runRoot}`);
  }
}

main().catch((error) => {
  console.error(`FAIL basic metrics semi-E2E: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
