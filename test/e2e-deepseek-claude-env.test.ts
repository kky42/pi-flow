import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_CLAUDE_MODELS,
  buildDeepseekClaudeEnv,
  loadDotEnv,
  prepareDeepseekClaudeE2EEnv,
  resolveDeepseekApiKey,
} from "../scripts/e2e/lib/deepseek-claude-env.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DeepSeek-backed Claude Code E2E environment", () => {
  it("loads dotenv values without overriding exported values", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-flow-e2e-env-"));
    tempDirs.push(dir);
    const file = path.join(dir, ".env");
    writeFileSync(file, "DEEPSEEK_API_KEY=from-file\nQUOTED='quoted value'\n", "utf8");
    const env = { DEEPSEEK_API_KEY: "from-shell" };

    loadDotEnv(file, env);

    expect(env).toEqual({ DEEPSEEK_API_KEY: "from-shell", QUOTED: "quoted value" });
  });

  it("resolves an explicit credential variable before standard DeepSeek names", () => {
    const env = {
      CUSTOM_DEEPSEEK_TOKEN: "custom-token",
      DEEPSEEK_API_KEY: "standard-key",
      DEEPSEEK_API_TOKEN: "standard-token",
    };

    expect(resolveDeepseekApiKey(env, "CUSTOM_DEEPSEEK_TOKEN")).toBe("custom-token");
    expect(resolveDeepseekApiKey({ DEEPSEEK_API_TOKEN: "token-only" })).toBe("token-only");
    expect(resolveDeepseekApiKey({ ANTHROPIC_AUTH_TOKEN: "anthropic-token" })).toBeUndefined();
  });

  it("forces Claude Code onto DeepSeek and removes conflicting provider auth", () => {
    const env = buildDeepseekClaudeEnv({
      DEEPSEEK_API_TOKEN: "deepseek-token",
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      CLAUDE_CODE_USE_MANTLE: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh-token",
      CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://auth.example.com",
    });

    expect(env).toMatchObject({
      DEEPSEEK_API_KEY: "deepseek-token",
      ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: "deepseek-token",
      ANTHROPIC_MODEL: DEEPSEEK_CLAUDE_MODELS.default,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_CLAUDE_MODELS.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_CLAUDE_MODELS.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_CLAUDE_MODELS.haiku,
    });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_FOUNDRY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_ANTHROPIC_AWS");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_MANTLE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_CUSTOM_OAUTH_URL");
  });

  it("isolates Claude settings through a PATH wrapper without persisting the credential", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-flow-e2e-wrapper-"));
    tempDirs.push(dir);
    const sourceBin = path.join(dir, "source-bin");
    const runtimeDir = path.join(dir, "runtime");
    const capturePath = path.join(dir, "args.txt");
    const fakeClaude = path.join(sourceBin, "claude");
    mkdirSync(sourceBin, { recursive: true });
    writeFileSync(fakeClaude, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"\n", "utf8");
    chmodSync(fakeClaude, 0o755);

    const env = prepareDeepseekClaudeE2EEnv({
      PATH: sourceBin,
      CAPTURE_PATH: capturePath,
      DEEPSEEK_API_KEY: "deepseek-secret",
    }, { runtimeDir });
    const wrapperPath = path.join(runtimeDir, "bin", "claude");

    const run = spawnSync("claude", ["-p"], { env, encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(readFileSync(capturePath, "utf8").split("\n")).toEqual([
      "--setting-sources",
      "",
      "-p",
      "",
    ]);
    expect(readFileSync(wrapperPath, "utf8")).not.toContain("deepseek-secret");
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(runtimeDir, "config"));
    expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(true);
    expect(env.PATH?.startsWith(path.join(runtimeDir, "bin"))).toBe(true);
  });

  it("requires every real-model E2E driver to install the provider guard", () => {
    const drivers = [
      "claude-subagent.mjs",
      "codex-subagent.mjs",
      "main-agent-comparison.mjs",
      "session-key-resume.mjs",
      "workflow-features.mjs",
    ];

    for (const driver of drivers) {
      const source = readFileSync(path.join(process.cwd(), "scripts", "e2e", driver), "utf8");
      expect(source, driver).toContain("prepareDeepseekClaudeE2EEnv(");
    }
  });

  it("fails instead of falling back to Claude Code login", () => {
    expect(() => buildDeepseekClaudeEnv({ ANTHROPIC_AUTH_TOKEN: "anthropic-token" }))
      .toThrow(/requires a DeepSeek credential.*Anthropic login is intentionally not used/);
  });
});
