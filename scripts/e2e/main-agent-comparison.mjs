#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(repoRoot, ".env"));

const scenarios = [
  {
    id: "codebase-exploration",
    fixture: "primary",
    prompt:
      "I just opened this project and need a quick orientation. What is it for, where is the important code, and what should I run to check it? Please just report back; don't change files.",
  },
  {
    id: "review",
    fixture: "primary",
    prompt:
      "Can you review this codebase for a few concrete maintainability or testing risks? Please cite the files that led you there, and don't change anything.",
  },
  {
    id: "qa-about-codebase",
    expectedBehavior: "direct",
    fixture: "primary",
    prompt:
      "What package name and license does this repo declare? Please answer from the repo files.",
  },
  {
    id: "implement-feature",
    fixture: "primary",
    prompt:
      "Please add a short README section called \"Local checks\" that tells contributors the main command to run before opening a pull request.",
  },
  {
    id: "compare-codebases",
    fixture: "both",
    prompt:
      "I'm choosing between ./ky and ./got for a small project. Can you compare their purpose, rough architecture, and test setup?",
  },
];

function parseArgs(argv) {
  const options = {
    cwd: repoRoot,
    extension: path.join(repoRoot, "index.ts"),
    model: "deepseek/deepseek-v4-flash",
    thinking: "high",
    sessionRoot: path.join(tmpdir(), `pi-subagent-main-agent-e2e-${Date.now()}`),
    timeoutMs: 120_000,
    repeat: 1,
    primaryRepo: "https://github.com/sindresorhus/ky.git",
    primaryName: "ky",
    secondaryRepo: "https://github.com/sindresorhus/got.git",
    secondaryName: "got",
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    withClaude: false,
    strictClaude: false,
    strictObserved: false,
    claudeModel: "haiku",
    claudeEffort: "high",
    claudeTimeoutMs: 120_000,
    claudeMaxBudgetUsd: "0.80",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--with-claude") {
      options.withClaude = true;
      continue;
    }
    if (arg === "--strict-claude") {
      options.strictClaude = true;
      continue;
    }
    if (arg === "--strict-observed") {
      options.strictObserved = true;
      continue;
    }
    const readValue = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--cwd") options.cwd = path.resolve(readValue());
    else if (arg === "--extension") options.extension = path.resolve(readValue());
    else if (arg === "--model") options.model = readValue();
    else if (arg === "--thinking") options.thinking = readValue();
    else if (arg === "--session-root") options.sessionRoot = path.resolve(readValue());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(readValue());
    else if (arg === "--repeat") options.repeat = Number(readValue());
    else if (arg === "--primary-repo") options.primaryRepo = readValue();
    else if (arg === "--primary-name") options.primaryName = readValue();
    else if (arg === "--secondary-repo") options.secondaryRepo = readValue();
    else if (arg === "--secondary-name") options.secondaryName = readValue();
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = readValue();
    else if (arg === "--claude-model") options.claudeModel = readValue();
    else if (arg === "--claude-effort") options.claudeEffort = readValue();
    else if (arg === "--claude-timeout-ms") options.claudeTimeoutMs = Number(readValue());
    else if (arg === "--claude-max-budget-usd") options.claudeMaxBudgetUsd = readValue();
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/e2e/main-agent-comparison.mjs [options]

Runs main-agent behavior scenarios against pi. With --with-claude, runs the same
scenarios through Claude Code and compares whether each main agent delegated or
handled the task directly. Behavior differences are reported but do not fail the
run unless a scenario has an explicit expectedBehavior.

Options:
  --model <id>                   pi model (default: deepseek/deepseek-v4-flash)
  --thinking <level>             pi thinking level (default: high)
  --session-root <dir>           artifact root (default: OS temp dir)
  --timeout-ms <ms>              per-pi-scenario timeout (default: 120000)
  --repeat <n>                   repetitions per scenario (default: 1)
  --primary-repo <url>           GitHub repo for single-codebase scenarios
  --secondary-repo <url>         GitHub repo for two-codebase comparison
  --deepseek-api-key-env <name>  env var used for pi and Claude DeepSeek auth
  --with-claude                  also run Claude Code comparison
  --strict-claude                fail if a Claude Code scenario is incomplete or unexpected
  --strict-observed              fail incomplete observed scenarios too
  --claude-model <id>            Claude Code model alias/id (default: haiku)
  --claude-effort <level>        Claude Code effort (default: high)
  --claude-timeout-ms <ms>       per-Claude-scenario timeout (default: 120000)
  --claude-max-budget-usd <usd>  Claude Code budget cap (default: 0.80)
`);
}

function ensureDirectory(dir) {
  mkdirSync(dir, { recursive: true });
}

function runText(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

function getDeepseekApiKey(options) {
  return process.env[options.deepseekApiKeyEnv] || process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY;
}

function buildPiEnv(options, sessionDir) {
  const env = { ...process.env };
  const key = getDeepseekApiKey(options);
  if (key) {
    const agentDir = path.join(sessionDir, "agent");
    ensureDirectory(agentDir);
    env.PI_CODING_AGENT_DIR = agentDir;
    env.DEEPSEEK_API_KEY = key;
    writeFileSync(
      path.join(agentDir, "auth.json"),
      `${JSON.stringify({ deepseek: { type: "api_key", key } }, null, 2)}\n`,
    );
  }
  return env;
}

function buildClaudeEnv(options) {
  const env = { ...process.env };
  const key = getDeepseekApiKey(options);
  if (key) {
    env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_MODEL = "deepseek-v4-pro[1m]";
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]";
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro[1m]";
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash[1m]";
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  return env;
}

async function cloneRepo({ url, name, baseDir, timeoutMs }) {
  const repoDir = path.join(baseDir, name);
  if (existsSync(repoDir)) {
    return {
      name,
      url,
      path: repoDir,
      commit: runText("git", ["rev-parse", "HEAD"], repoDir),
    };
  }

  ensureDirectory(baseDir);
  const logDir = path.join(baseDir, "_clone-logs");
  ensureDirectory(logDir);
  const command = await runProcess({
    command: "git",
    args: ["clone", "--depth", "1", url, repoDir],
    cwd: baseDir,
    stdoutPath: path.join(logDir, `${name}.stdout.txt`),
    stderrPath: path.join(logDir, `${name}.stderr.txt`),
    timeoutMs,
  });
  if (command.exitCode !== 0 || command.timedOut) {
    throw new Error(`Failed to clone ${url}. See ${logDir}`);
  }

  return {
    name,
    url,
    path: repoDir,
    commit: runText("git", ["rev-parse", "HEAD"], repoDir),
  };
}

async function prepareFixtures(options) {
  const baseDir = path.join(options.sessionRoot, "fixtures", "base");
  const primary = await cloneRepo({
    url: options.primaryRepo,
    name: options.primaryName,
    baseDir,
    timeoutMs: options.timeoutMs,
  });
  const secondary = await cloneRepo({
    url: options.secondaryRepo,
    name: options.secondaryName,
    baseDir,
    timeoutMs: options.timeoutMs,
  });
  return { baseDir, primary, secondary };
}

function prepareScenarioWorkdir(options, fixtures, sessionDir, scenario) {
  const workRoot = path.join(sessionDir, "work");
  rmSync(workRoot, { recursive: true, force: true });
  ensureDirectory(workRoot);

  const primaryTarget = path.join(workRoot, fixtures.primary.name);
  cpSync(fixtures.primary.path, primaryTarget, { recursive: true });

  if (scenario.fixture === "both") {
    const secondaryTarget = path.join(workRoot, fixtures.secondary.name);
    cpSync(fixtures.secondary.path, secondaryTarget, { recursive: true });
    return workRoot;
  }

  return primaryTarget;
}

function writePromptFile(sessionDir, scenario, kind) {
  const promptPath = path.join(sessionDir, "prompt.md");
  const expectedLine = scenario.expectedBehavior
    ? `Expected behavior: ${scenario.expectedBehavior}`
    : "Expected behavior: observe and report";
  writeFileSync(
    promptPath,
    `# ${kind} Main-Agent Behavior E2E

Scenario: ${scenario.id}
${expectedLine}

${scenario.prompt}
`,
  );
  return promptPath;
}

function runProcess({ command, args, cwd, stdoutPath, stderrPath, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const stdout = createWriteStream(stdoutPath, { flags: "a" });
    const stderr = createWriteStream(stderrPath, { flags: "a" });
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let timedOut = false;
    let settled = false;
    let errorMessage;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.on("error", (error) => {
      errorMessage = error.message;
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      stdout.end();
      stderr.end();
      resolve({
        command,
        args,
        cwd,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        signal,
        timedOut,
        errorMessage,
      });
    });
  });
}

function readJsonlRecords(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function findNewestJsonl(dir) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => path.join(dir, file))
    .sort();
  return files.at(-1);
}

function countTool(map, name) {
  map[name] = (map[name] ?? 0) + 1;
}

function analyzePiTrace(filePath) {
  const toolCalls = {};
  const toolResults = {};
  const finalTexts = [];

  for (const record of readJsonlRecords(filePath)) {
    const message = record.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      if (item?.type === "toolCall" && typeof item.name === "string") {
        countTool(toolCalls, item.name);
      }
      if (item?.type === "text" && typeof item.text === "string" && message?.role === "assistant") {
        finalTexts.push(item.text);
      }
    }
    if (message?.role === "toolResult" && typeof message.toolName === "string") {
      countTool(toolResults, message.toolName);
    }
  }

  const agentCalls = toolCalls.Agent ?? 0;
  return {
    filePath,
    toolCalls,
    toolResults,
    agentCalls,
    readCalls: toolCalls.read ?? 0,
    behavior: agentCalls > 0 ? "delegate" : "direct",
    finalText: finalTexts.at(-1) ?? "",
  };
}

function analyzeClaudeTrace(filePath) {
  const toolCalls = {};
  const taskStarts = [];
  const resultErrors = [];
  const finalTexts = [];

  for (const record of readJsonlRecords(filePath)) {
    if (record.type === "system" && record.subtype === "task_started") {
      taskStarts.push(record);
    }
    if (record.type === "result" && record.is_error) {
      resultErrors.push(record.subtype ?? record.stop_reason ?? "error");
    }

    const message = record.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    const isRootMessage = !record.parent_tool_use_id;
    for (const item of content) {
      if (isRootMessage && item?.type === "tool_use" && typeof item.name === "string") {
        countTool(toolCalls, item.name);
      }
      if (isRootMessage && item?.type === "text" && typeof item.text === "string" && message?.role === "assistant") {
        finalTexts.push(item.text);
      }
    }
  }

  const agentCalls = toolCalls.Agent ?? 0;
  return {
    filePath,
    toolCalls,
    taskStarts: taskStarts.length,
    resultErrors,
    agentCalls,
    readCalls: toolCalls.Read ?? 0,
    behavior: agentCalls > 0 || taskStarts.length > 0 ? "delegate" : "direct",
    finalText: finalTexts.at(-1) ?? "",
  };
}

async function runPiScenario(options, fixtures, scenario, repeatIndex) {
  const sessionDir = path.join(options.sessionRoot, "pi", scenario.id, `r${repeatIndex}`);
  ensureDirectory(sessionDir);
  const workCwd = prepareScenarioWorkdir(options, fixtures, sessionDir, scenario);
  const promptPath = writePromptFile(sessionDir, scenario, "pi");
  const stdoutPath = path.join(sessionDir, "stdout.txt");
  const stderrPath = path.join(sessionDir, "stderr.txt");
  const args = [
    "-p",
    "--model",
    options.model,
    "--thinking",
    options.thinking,
    "--session-dir",
    sessionDir,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
    "--extension",
    options.extension,
    `@${promptPath}`,
  ];
  const command = await runProcess({
    command: "pi",
    args,
    cwd: workCwd,
    stdoutPath,
    stderrPath,
    timeoutMs: options.timeoutMs,
    env: buildPiEnv(options, sessionDir),
  });
  const trace = analyzePiTrace(findNewestJsonl(sessionDir));
  const pass =
    command.exitCode === 0 &&
    !command.timedOut &&
    (!scenario.expectedBehavior || trace.behavior === scenario.expectedBehavior) &&
    (!scenario.requirePiRead || trace.readCalls > 0);

  const result = {
    kind: "pi",
    scenario: scenario.id,
    repeat: repeatIndex,
    expectedBehavior: scenario.expectedBehavior,
    required: Boolean(scenario.expectedBehavior),
    pass,
    command,
    sessionDir,
    workCwd,
    stdoutPath,
    stderrPath,
    trace,
  };
  writeFileSync(path.join(sessionDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function runClaudeScenario(options, fixtures, scenario, repeatIndex) {
  const sessionDir = path.join(options.sessionRoot, "claude", scenario.id, `r${repeatIndex}`);
  ensureDirectory(sessionDir);
  const workCwd = prepareScenarioWorkdir(options, fixtures, sessionDir, scenario);
  const promptPath = writePromptFile(sessionDir, scenario, "Claude Code");
  const stdoutPath = path.join(sessionDir, "stream.jsonl");
  const stderrPath = path.join(sessionDir, "stderr.txt");
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--max-budget-usd",
    options.claudeMaxBudgetUsd,
    "--effort",
    options.claudeEffort,
    "--permission-mode",
    "bypassPermissions",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
    "--no-session-persistence",
  ];
  if (options.claudeModel) args.push("--model", options.claudeModel);
  args.push(readFileSync(promptPath, "utf8"));

  const command = await runProcess({
    command: "claude",
    args,
    cwd: workCwd,
    stdoutPath,
    stderrPath,
    timeoutMs: options.claudeTimeoutMs,
    env: buildClaudeEnv(options),
  });
  const trace = analyzeClaudeTrace(stdoutPath);
  const completed = command.exitCode === 0 && !command.timedOut && trace.resultErrors.length === 0;
  const pass = completed && (!scenario.expectedBehavior || trace.behavior === scenario.expectedBehavior);

  const result = {
    kind: "claude",
    scenario: scenario.id,
    repeat: repeatIndex,
    expectedBehavior: scenario.expectedBehavior,
    required: Boolean(scenario.expectedBehavior),
    pass,
    completed,
    command,
    sessionDir,
    workCwd,
    stdoutPath,
    stderrPath,
    trace,
  };
  writeFileSync(path.join(sessionDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function formatResult(result, options = {}) {
  let status = result.pass ? "PASS" : "FAIL";
  if ((result.kind === "pi" || result.kind === "claude") && !result.required && !result.pass) {
    status = "INCONCLUSIVE";
  }
  if (result.kind === "claude" && !options.strictClaude && !result.required && !result.pass) {
    status = "INCONCLUSIVE";
  }
  const expected = result.expectedBehavior ?? "observe";
  const parts = [
    status,
    result.kind,
    `${result.scenario}#${result.repeat ?? 1}`,
    `expected=${expected}`,
    `observed=${result.trace.behavior}`,
    `agentCalls=${result.trace.agentCalls}`,
  ];
  if (result.kind === "pi") parts.push(`readCalls=${result.trace.readCalls}`);
  if (result.kind === "claude") {
    parts.push(`completed=${result.completed}`);
    if (result.command.timedOut) parts.push("timeout=true");
    if (result.trace.resultErrors.length) parts.push(`errors=${result.trace.resultErrors.join(",")}`);
  }
  return parts.join(" ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  ensureDirectory(options.sessionRoot);
  const fixtures = await prepareFixtures(options);
  const results = [];
  for (let repeatIndex = 1; repeatIndex <= options.repeat; repeatIndex += 1) {
    for (const scenario of scenarios) {
      const piResult = await runPiScenario(options, fixtures, scenario, repeatIndex);
      results.push(piResult);
      console.log(formatResult(piResult, options));

      if (options.withClaude) {
        const claudeResult = await runClaudeScenario(options, fixtures, scenario, repeatIndex);
        results.push(claudeResult);
        console.log(formatResult(claudeResult, options));

        const comparisonMatch = piResult.trace.behavior === claudeResult.trace.behavior;
        const comparisonRequired = Boolean(scenario.expectedBehavior);
        const comparisonPass = !comparisonRequired || comparisonMatch;
        results.push({
          kind: "comparison",
          scenario: scenario.id,
          repeat: repeatIndex,
          pass: comparisonPass,
          required: comparisonRequired,
          match: comparisonMatch,
          piBehavior: piResult.trace.behavior,
          claudeBehavior: claudeResult.trace.behavior,
        });
        console.log(
          `${comparisonMatch ? "MATCH" : "DIFF"} comparison ${scenario.id}#${repeatIndex} pi=${piResult.trace.behavior} claude=${claudeResult.trace.behavior}`,
        );
      }
    }
  }

  const reportPath = path.join(options.sessionRoot, "report.json");
  writeFileSync(reportPath, `${JSON.stringify({ options, fixtures, scenarios, results }, null, 2)}\n`);
  console.log(`report=${reportPath}`);

  const failed = results.filter((result) => {
    if (result.kind === "pi") return !result.pass && (result.required || options.strictObserved);
    if (result.kind === "claude") {
      return options.strictClaude && !result.pass && (result.required || options.strictObserved);
    }
    return false;
  });
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
