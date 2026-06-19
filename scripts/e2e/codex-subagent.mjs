#!/usr/bin/env node
// Real end-to-end smoke for Codex CLI-backed subagents.
//
// This creates a temporary custom subagent profile under the selected pi agent
// dir, then runs a fresh `pi -p` session that is only allowed to use the Agent
// tool. The selected profile uses `backend: codex`, `model: gpt-5.4-mini`, and
// `thinking: medium`, so a successful run proves the root pi agent launched a
// real Codex CLI child through the extension.
//
// Usage:
//   node scripts/e2e/codex-subagent.mjs
//   node scripts/e2e/codex-subagent.mjs --root-model openai/gpt-5.4-mini --root-thinking medium --keep

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(repoRoot, "index.ts");

function parseArgs(argv) {
  const options = {
    rootModel: "openai/gpt-5.4-mini",
    rootThinking: "medium",
    codexModel: "gpt-5.4-mini",
    codexThinking: "medium",
    agentDir: process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
    runRoot: path.join(tmpdir(), `pi-codex-subagent-e2e-${Date.now()}`),
    keep: false,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === "--root-model") options.rootModel = value();
    else if (arg === "--root-thinking") options.rootThinking = value();
    else if (arg === "--codex-model") options.codexModel = value();
    else if (arg === "--codex-thinking") options.codexThinking = value();
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/e2e/codex-subagent.mjs [options]\n\nOptions:\n  --root-model <provider/model>   pi root model (default: openai/gpt-5.4-mini)\n  --root-thinking <level>         pi root thinking level (default: medium)\n  --codex-model <model>           Codex CLI subagent model (default: gpt-5.4-mini)\n  --codex-thinking <level>        profile thinking level passed to Codex (default: medium)\n  --agent-dir <dir>               pi agent dir (default: PI_CODING_AGENT_DIR or ~/.pi/agent)\n  --run-root <dir>                temp run root\n  --timeout-ms <ms>               pi process timeout (default: 180000)\n  --keep                          keep temp run root and temporary profile\n`);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function shell(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  return result;
}

function writeFixture(runRoot) {
  const fixture = path.join(runRoot, "fixture");
  ensureDir(fixture);
  writeFileSync(path.join(fixture, "e2e-target.txt"), "gpt-5.4-mini-medium\n", "utf8");
  writeFileSync(path.join(fixture, "README.md"), "# Codex subagent E2E\n\nRead e2e-target.txt and report the token.\n", "utf8");
  shell("git", ["init", "-q"], { cwd: fixture });
  shell("git", ["add", "."], { cwd: fixture });
  shell("git", ["-c", "user.name=pi-flow-e2e", "-c", "user.email=pi-flow-e2e@example.invalid", "commit", "-qm", "fixture"], { cwd: fixture });
  return fixture;
}

function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function readAllTextUnder(root) {
  return listFilesRecursive(root)
    .map((file) => {
      try {
        return `\n--- ${file} ---\n${readFileSync(file, "utf8")}`;
      } catch {
        return "";
      }
    })
    .join("\n");
}

function runPi({ command, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, error, timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const profileName = `zz-e2e-codex-${Date.now()}`;
  const subagentsDir = path.join(options.agentDir, "subagents");
  const profilePath = path.join(subagentsDir, `${profileName}.md`);
  ensureDir(options.runRoot);
  ensureDir(subagentsDir);
  const fixture = writeFixture(options.runRoot);
  const sessionDir = path.join(options.runRoot, "sessions");
  ensureDir(sessionDir);

  const profile = `---\ndescription: E2E Codex CLI smoke profile.\nbackend: codex\nmodel: ${options.codexModel}\nthinking: ${options.codexThinking}\n---\n\nYou are a Codex CLI subagent used by pi-flow E2E. Use the repository files to answer exactly what was asked. Do not edit files.\n`;
  writeFileSync(profilePath, profile, "utf8");

  const promptPath = path.join(options.runRoot, "prompt.md");
  const expected = "CODEX_SUBAGENT_OK:gpt-5.4-mini-medium";
  writeFileSync(promptPath, `You are testing pi-flow Codex CLI backend.\n\nYou MUST call the Agent tool exactly once with subagent_type \"${profileName}\".\nUse description \"Codex CLI smoke\".\nThe subagent prompt must be:\n\nRead e2e-target.txt in the current working directory and reply with exactly this format and nothing else: CODEX_SUBAGENT_OK:<file content without surrounding whitespace>\n\nAfter the Agent result returns, reply with the subagent's exact final token line.\nExpected token line: ${expected}\n`, "utf8");

  const command = [
    "pi",
    "-p",
    "--mode", "json",
    "--model", options.rootModel,
    "--thinking", options.rootThinking,
    "--session-dir", sessionDir,
    "--no-extensions",
    "--extension", extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "Agent",
    "--approve",
    `@${promptPath}`,
  ];

  console.log(`Running: ${command.join(" ")}`);
  console.log(`Fixture: ${fixture}`);
  console.log(`Session dir: ${sessionDir}`);
  console.log(`Profile: ${profilePath}`);
  console.log(`Codex profile model/thinking: ${options.codexModel}/${options.codexThinking}`);
  console.log(`Root pi model/thinking: ${options.rootModel}/${options.rootThinking}`);

  let run;
  try {
    run = await runPi({
      command,
      cwd: fixture,
      env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
      timeoutMs: options.timeoutMs,
    });

    const transcriptText = `${run.stdout}\n${run.stderr}\n${readAllTextUnder(sessionDir)}`;
    const gitStatus = shell("git", ["status", "--short"], { cwd: fixture });

    assert(!run.timedOut, `pi timed out after ${options.timeoutMs}ms`);
    assert(run.code === 0, `pi exited with ${run.code}${run.signal ? ` (${run.signal})` : ""}\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`);
    assert(transcriptText.includes(profileName), `session/output did not mention profile ${profileName}`);
    assert(transcriptText.includes("Agent"), "session/output did not record Agent tool usage");
    assert(transcriptText.includes(expected), `expected Codex subagent token not found: ${expected}`);
    assert(gitStatus.status === 0, `git status failed: ${gitStatus.stderr}`);
    assert(gitStatus.stdout.trim() === "", `fixture was modified:\n${gitStatus.stdout}`);

    console.log("PASS codex subagent E2E");
    console.log(`Observed token: ${expected}`);
  } finally {
    if (!options.keep) {
      try { unlinkSync(profilePath); } catch {}
      rmSync(options.runRoot, { recursive: true, force: true });
    } else {
      console.log(`Kept run root: ${options.runRoot}`);
      console.log(`Kept profile: ${profilePath}`);
      if (run) {
        writeFileSync(path.join(options.runRoot, "stdout.jsonl"), run.stdout ?? "", "utf8");
        writeFileSync(path.join(options.runRoot, "stderr.log"), run.stderr ?? "", "utf8");
      }
    }
  }
}

main().catch((error) => {
  console.error(`FAIL codex subagent E2E: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
