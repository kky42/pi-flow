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

const fixtureSpecs = [
  {
    size: "small",
    label: "small (1-10 files)",
    repo: "https://github.com/octocat/Spoon-Knife.git",
    name: "spoon-knife",
  },
  {
    size: "medium",
    label: "medium (10-100 files)",
    repo: "https://github.com/chalk/chalk.git",
    name: "chalk",
  },
  {
    size: "large",
    label: "large (100+ files)",
    repo: "https://github.com/expressjs/express.git",
    name: "express",
  },
  {
    size: "huge",
    label: "huge (500+ files)",
    repo: "https://github.com/vuejs/core.git",
    name: "vue-core",
  },
];

const taskSpecs = [
  {
    task: "exploration",
    prompt:
      "I just opened this project. Can you give me a practical orientation: what it appears to do, where the important code lives, and what command or file I should check first? Please don't change files.",
  },
  {
    task: "understanding",
    prompt:
      "I need to understand the main moving parts of this project before working here. Can you explain how the pieces fit together and cite the files you used? Please don't change anything.",
  },
  {
    task: "implementation",
    prompt:
      "Please add a short \"Local checks\" section to the main README with the most relevant command or instruction contributors should run before opening a pull request. Keep it minimal and consistent with the repo.",
  },
];

const workflowTaskPrompt =
  "Run a workflow to orient me in this repository: fan out subagents — one to inventory the top-level structure and entry points, one to summarize how the project is built and tested, and one to list the main runtime modules — then synthesize a short orientation from their findings. Please don't change any files.";

const baseScenarios = taskSpecs.flatMap((taskSpec) =>
  fixtureSpecs.map((fixture) => ({
    id: `${taskSpec.task}-${fixture.size}`,
    task: taskSpec.task,
    size: fixture.size,
    fixture: fixture.size,
    prompt: taskSpec.prompt,
  })),
);

// Workflow fan-out only makes sense on multi-file repos, so it runs on the
// medium/large buckets. Observational by default (INCONCLUSIVE if the model
// doesn't reach for the workflow tool); use --strict-observed to require it.
const workflowScenarios = ["medium", "large"].map((size) => ({
  id: `workflow-${size}`,
  task: "workflow",
  size,
  fixture: size,
  prompt: workflowTaskPrompt,
  expectedTool: "workflow",
}));

const scenarios = [...baseScenarios, ...workflowScenarios];

function parseArgs(argv) {
  const options = {
    cwd: repoRoot,
    extension: path.join(repoRoot, "index.ts"),
    model: "deepseek/deepseek-v4-flash",
    thinking: "high",
    sessionRoot: path.join(tmpdir(), `pi-flow-main-agent-e2e-${Date.now()}`),
    timeoutMs: 0,
    maxToolCalls: 50,
    repeat: 1,
    fixtures: Object.fromEntries(
      fixtureSpecs.map((fixture) => [fixture.size, { repo: fixture.repo, name: fixture.name }]),
    ),
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    withClaude: false,
    strictClaude: false,
    strictObserved: false,
    claudeModel: "haiku",
    claudeEffort: "high",
    claudeTimeoutMs: 0,
    claudeMaxBudgetUsd: undefined,
    claudeExcludeDynamicSystemPromptSections: false,
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
    if (arg === "--claude-exclude-dynamic-system-prompt-sections") {
      options.claudeExcludeDynamicSystemPromptSections = true;
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
    else if (arg === "--max-tool-calls") options.maxToolCalls = Number(readValue());
    else if (arg === "--repeat") options.repeat = Number(readValue());
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = readValue();
    else if (arg === "--claude-model") options.claudeModel = readValue();
    else if (arg === "--claude-effort") options.claudeEffort = readValue();
    else if (arg === "--claude-timeout-ms") options.claudeTimeoutMs = Number(readValue());
    else if (arg === "--claude-max-budget-usd") options.claudeMaxBudgetUsd = readValue();
    else {
      const fixtureOption = fixtureSpecs.find(
        (fixture) => arg === `--${fixture.size}-repo` || arg === `--${fixture.size}-name`,
      );
      if (fixtureOption && arg.endsWith("-repo")) {
        options.fixtures[fixtureOption.size].repo = readValue();
      } else if (fixtureOption && arg.endsWith("-name")) {
        options.fixtures[fixtureOption.size].name = readValue();
      } else {
        throw new Error(`Unknown option: ${arg}`);
      }
    }
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
  --timeout-ms <ms>              per-pi-scenario timeout; 0 disables (default: 0)
  --max-tool-calls <n>           stop a run after this many root tool calls; 0 disables (default: 50)
  --repeat <n>                   repetitions per scenario (default: 1)
  --small-repo <url>             fixture repo for the small bucket
  --small-name <name>            local directory name for the small bucket
  --medium-repo <url>            fixture repo for the medium bucket
  --medium-name <name>           local directory name for the medium bucket
  --large-repo <url>             fixture repo for the large bucket
  --large-name <name>            local directory name for the large bucket
  --huge-repo <url>              fixture repo for the huge bucket
  --huge-name <name>             local directory name for the huge bucket
  --deepseek-api-key-env <name>  env var used for pi and Claude DeepSeek auth
  --with-claude                  also run Claude Code comparison
  --strict-claude                fail if a Claude Code scenario is incomplete or unexpected
  --strict-observed              fail incomplete observed scenarios too
  --claude-model <id>            Claude Code model alias/id (default: haiku)
  --claude-effort <level>        Claude Code effort (default: high)
  --claude-timeout-ms <ms>       per-Claude-scenario timeout; 0 disables (default: 0)
  --claude-max-budget-usd <usd>  optional Claude Code budget cap (default: unset)
  --claude-exclude-dynamic-system-prompt-sections
                                  opt into Claude Code prompt-cache mode; off by default
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

function getTrackedFileCount(repoDir) {
  const files = runText("git", ["ls-files"], repoDir);
  if (!files) return 0;
  return files.split("\n").filter(Boolean).length;
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
      fileCount: getTrackedFileCount(repoDir),
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
    fileCount: getTrackedFileCount(repoDir),
  };
}

async function prepareFixtures(options) {
  const baseDir = path.join(options.sessionRoot, "fixtures", "base");
  const repos = {};
  for (const fixture of fixtureSpecs) {
    const configured = options.fixtures[fixture.size];
    repos[fixture.size] = await cloneRepo({
      url: configured.repo,
      name: configured.name,
      baseDir,
      timeoutMs: options.timeoutMs,
    });
  }
  return { baseDir, repos };
}

function prepareScenarioWorkdir(options, fixtures, sessionDir, scenario) {
  const workRoot = path.join(sessionDir, "work");
  rmSync(workRoot, { recursive: true, force: true });
  ensureDirectory(workRoot);

  const fixture = fixtures.repos[scenario.fixture];
  if (!fixture) {
    throw new Error(`Unknown fixture for scenario ${scenario.id}: ${scenario.fixture}`);
  }

  const target = path.join(workRoot, fixture.name);
  cpSync(fixture.path, target, { recursive: true });
  return target;
}

function writePromptFile(sessionDir, scenario, kind) {
  const promptPath = path.join(sessionDir, "prompt.md");
  writeFileSync(
    promptPath,
    `${scenario.prompt}\n`,
  );
  return promptPath;
}

const CLAUDE_ALWAYS_SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const CLAUDE_TASK_MANAGEMENT_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
]);
const CLAUDE_NON_DELEGATION_AGENT_NAMES = new Set(["claude"]);

function textContainsPiSubagentInvocation(text) {
  return /"name"\s*:\s*"(?:Agent|workflow)"/.test(text);
}

function addClaudeAgentNames(target, names) {
  if (!Array.isArray(names)) return;
  for (const agentName of names) {
    if (typeof agentName === "string" && !CLAUDE_NON_DELEGATION_AGENT_NAMES.has(agentName)) {
      target.add(agentName);
    }
  }
}

function isClaudeSubagentToolUse(item, subagentToolNames) {
  return (
    item?.type === "tool_use" &&
    typeof item.name === "string" &&
    (subagentToolNames.has(item.name) || typeof item.input?.subagent_type === "string")
  );
}

function createClaudeSubagentInvocationDetector() {
  const subagentToolNames = new Set(CLAUDE_ALWAYS_SUBAGENT_TOOL_NAMES);
  let buffer = "";

  return (text) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        if (/"subagent_type"\s*:/.test(line)) return true;
        continue;
      }

      if (record.type === "system" && record.subtype === "init") {
        addClaudeAgentNames(subagentToolNames, record.agents);
      }
      if (record.type === "system" && record.subtype === "task_started") {
        return true;
      }

      const isRootMessage = !record.parent_tool_use_id;
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      if (isRootMessage && content.some((item) => isClaudeSubagentToolUse(item, subagentToolNames))) {
        return true;
      }
    }

    return false;
  };
}

function directoryContainsAgentInvocation(dir, detector) {
  const tracePath = findNewestJsonl(dir);
  if (!tracePath) return false;
  return detector(readFileSync(tracePath, "utf8"));
}

function countPiRootToolCalls(filePath) {
  let count = 0;
  for (const record of readJsonlRecords(filePath)) {
    const content = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const item of content) {
      if (item?.type === "toolCall" && typeof item.name === "string") count += 1;
    }
  }
  return count;
}

function directoryHitsToolLimit(dir, maxToolCalls, counter) {
  if (!maxToolCalls || maxToolCalls <= 0 || !counter) return false;
  const tracePath = findNewestJsonl(dir);
  if (!tracePath) return false;
  return counter(tracePath) >= maxToolCalls;
}

function createClaudeToolLimitDetector(maxToolCalls) {
  if (!maxToolCalls || maxToolCalls <= 0) return undefined;
  let buffer = "";
  let count = 0;

  return (text) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.parent_tool_use_id) continue;
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      for (const item of content) {
        if (item?.type === "tool_use" && typeof item.name === "string") {
          count += 1;
          if (count >= maxToolCalls) return true;
        }
      }
    }

    return false;
  };
}

function runProcess({
  command,
  args,
  cwd,
  stdoutPath,
  stderrPath,
  timeoutMs,
  env = process.env,
  stopOnAgentInvocation = false,
  monitorDir,
  agentInvocationDetector = textContainsPiSubagentInvocation,
  maxToolCalls = 0,
  toolLimitDetector,
  monitorToolCallCounter,
}) {
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
    let stoppedOnAgentInvocation = false;
    let stoppedOnToolLimit = false;
    let settled = false;
    let errorMessage;
    let killTimer;
    let timeout;
    let monitor;
    const stopChild = (reason) => {
      if (settled) return;
      if (reason === "agent") stoppedOnAgentInvocation = true;
      if (reason === "tool-limit") stoppedOnToolLimit = true;
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref();
      }
    };
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stopChild("timeout");
      }, timeoutMs);
      timeout.unref();
    }
    if (stopOnAgentInvocation && monitorDir) {
      monitor = setInterval(() => {
        if (directoryContainsAgentInvocation(monitorDir, agentInvocationDetector)) {
          stopChild("agent");
        } else if (directoryHitsToolLimit(monitorDir, maxToolCalls, monitorToolCallCounter)) {
          stopChild("tool-limit");
        }
      }, 200);
      monitor.unref();
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout.write(chunk);
      if (stopOnAgentInvocation && agentInvocationDetector(text)) {
        stopChild("agent");
      } else if (toolLimitDetector?.(text)) {
        stopChild("tool-limit");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
    });
    child.on("error", (error) => {
      errorMessage = error.message;
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (monitor) clearInterval(monitor);
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
        stoppedOnAgentInvocation,
        stoppedOnToolLimit,
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
  const workflowCalls = toolCalls.workflow ?? 0;
  const rootToolCalls = Object.values(toolCalls).reduce((sum, count) => sum + count, 0);
  return {
    filePath,
    toolCalls,
    toolResults,
    agentCalls,
    workflowCalls,
    rootToolCalls,
    readCalls: toolCalls.read ?? 0,
    behavior: agentCalls > 0 || workflowCalls > 0 ? "delegate" : "direct",
    finalText: finalTexts.at(-1) ?? "",
  };
}

function analyzeClaudeTrace(filePath) {
  const toolCalls = {};
  const subagentToolCalls = {};
  const taskManagementToolCalls = {};
  const taskStarts = [];
  const resultErrors = [];
  const finalTexts = [];
  const subagentToolNames = new Set(CLAUDE_ALWAYS_SUBAGENT_TOOL_NAMES);

  for (const record of readJsonlRecords(filePath)) {
    if (record.type === "system" && record.subtype === "init") {
      addClaudeAgentNames(subagentToolNames, record.agents);
    }
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
        if (isClaudeSubagentToolUse(item, subagentToolNames)) {
          countTool(subagentToolCalls, item.name);
        }
        if (CLAUDE_TASK_MANAGEMENT_TOOL_NAMES.has(item.name)) {
          countTool(taskManagementToolCalls, item.name);
        }
      }
      if (isRootMessage && item?.type === "text" && typeof item.text === "string" && message?.role === "assistant") {
        finalTexts.push(item.text);
      }
    }
  }

  const subagentToolCallCount = Object.values(subagentToolCalls).reduce((sum, count) => sum + count, 0);
  const agentCalls = Math.max(subagentToolCallCount, taskStarts.length);
  const rootToolCalls = Object.values(toolCalls).reduce((sum, count) => sum + count, 0);
  return {
    filePath,
    toolCalls,
    subagentToolCalls,
    taskManagementToolCalls,
    taskStarts: taskStarts.length,
    resultErrors,
    agentCalls,
    rootToolCalls,
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
    stopOnAgentInvocation: !scenario.expectedBehavior || scenario.expectedBehavior === "delegate",
    monitorDir: sessionDir,
    maxToolCalls: options.maxToolCalls,
    monitorToolCallCounter: countPiRootToolCalls,
  });
  const trace = analyzePiTrace(findNewestJsonl(sessionDir));
  const completedEnough =
    (command.exitCode === 0 && !command.timedOut) ||
    command.stoppedOnAgentInvocation ||
    command.stoppedOnToolLimit;
  const pass =
    completedEnough &&
    (!scenario.expectedBehavior || trace.behavior === scenario.expectedBehavior) &&
    (!scenario.requirePiRead || trace.readCalls > 0) &&
    (!scenario.expectedTool || (trace.toolCalls[scenario.expectedTool] ?? 0) > 0);

  const result = {
    kind: "pi",
    scenario: scenario.id,
    task: scenario.task,
    size: scenario.size,
    repeat: repeatIndex,
    expectedBehavior: scenario.expectedBehavior,
    expectedTool: scenario.expectedTool,
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
    "--effort",
    options.claudeEffort,
    "--permission-mode",
    "bypassPermissions",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
  if (options.claudeExcludeDynamicSystemPromptSections) {
    args.push("--exclude-dynamic-system-prompt-sections");
  }
  if (options.claudeMaxBudgetUsd) {
    args.push("--max-budget-usd", options.claudeMaxBudgetUsd);
  }
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
    stopOnAgentInvocation: !scenario.expectedBehavior || scenario.expectedBehavior === "delegate",
    agentInvocationDetector: createClaudeSubagentInvocationDetector(),
    maxToolCalls: options.maxToolCalls,
    toolLimitDetector: createClaudeToolLimitDetector(options.maxToolCalls),
  });
  const trace = analyzeClaudeTrace(stdoutPath);
  const completed = command.exitCode === 0 && !command.timedOut && trace.resultErrors.length === 0;
  const completedEnough = completed || command.stoppedOnAgentInvocation || command.stoppedOnToolLimit;
  const pass = completedEnough && (!scenario.expectedBehavior || trace.behavior === scenario.expectedBehavior);

  const result = {
    kind: "claude",
    scenario: scenario.id,
    task: scenario.task,
    size: scenario.size,
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
    `useSubagent=${result.trace.behavior === "delegate"}`,
    `agentCalls=${result.trace.agentCalls}`,
    `rootToolCalls=${result.trace.rootToolCalls ?? "?"}`,
  ];
  if (result.kind === "pi") parts.push(`readCalls=${result.trace.readCalls}`);
  if (result.kind === "pi" && result.trace.workflowCalls) parts.push(`workflowCalls=${result.trace.workflowCalls}`);
  if (result.expectedTool) parts.push(`expectedTool=${result.expectedTool}`);
  if (result.command?.stoppedOnAgentInvocation) parts.push("stoppedOnAgent=true");
  if (result.command?.stoppedOnToolLimit) parts.push("stoppedOnToolLimit=true");
  if (result.kind === "claude") {
    if (Object.keys(result.trace.subagentToolCalls ?? {}).length > 0) {
      parts.push(`subagentTools=${JSON.stringify(result.trace.subagentToolCalls)}`);
    }
    parts.push(`completed=${result.completed}`);
    if (result.command.timedOut) parts.push("timeout=true");
    if (result.trace.resultErrors.length) parts.push(`errors=${result.trace.resultErrors.join(",")}`);
  }
  return parts.join(" ");
}

function printComparisonSummary(results) {
  const comparisons = results.filter((result) => result.kind === "comparison");
  if (comparisons.length === 0) return;

  console.log("");
  console.log("Subagent use summary:");
  console.log("| task | size | pi | claude |");
  console.log("| --- | --- | --- | --- |");
  for (const comparison of comparisons) {
    const pi = comparison.piUsesSubagent ? "✅" : "❌";
    const claude = comparison.claudeUsesSubagent ? "✅" : "❌";
    console.log(
      `| ${comparison.task} | ${comparison.size} | ${pi} | ${claude} |`,
    );
  }
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
          task: scenario.task,
          size: scenario.size,
          repeat: repeatIndex,
          pass: comparisonPass,
          required: comparisonRequired,
          match: comparisonMatch,
          piBehavior: piResult.trace.behavior,
          claudeBehavior: claudeResult.trace.behavior,
          piUsesSubagent: piResult.trace.behavior === "delegate",
          claudeUsesSubagent: claudeResult.trace.behavior === "delegate",
        });
        console.log(
          `${comparisonMatch ? "MATCH" : "DIFF"} comparison ${scenario.id}#${repeatIndex} piUseSubagent=${piResult.trace.behavior === "delegate"} claudeUseSubagent=${claudeResult.trace.behavior === "delegate"}`,
        );
      }
    }
  }

  const reportPath = path.join(options.sessionRoot, "report.json");
  writeFileSync(reportPath, `${JSON.stringify({ options, fixtures, scenarios, results }, null, 2)}\n`);
  printComparisonSummary(results);
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
