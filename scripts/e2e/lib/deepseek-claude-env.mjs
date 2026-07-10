import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";

export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_CLAUDE_MODELS = Object.freeze({
  default: "deepseek-v4-pro[1m]",
  opus: "deepseek-v4-pro[1m]",
  sonnet: "deepseek-v4-pro[1m]",
  haiku: "deepseek-v4-flash[1m]",
});

const DEFAULT_CREDENTIAL_ENV_NAMES = ["DEEPSEEK_API_KEY", "DEEPSEEK_API_TOKEN"];

export function loadDotEnv(filePath, env = process.env) {
  if (!existsSync(filePath)) return env;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function deepseekCredentialEnvNames(preferredEnvName = "DEEPSEEK_API_KEY") {
  return [...new Set([preferredEnvName, ...DEFAULT_CREDENTIAL_ENV_NAMES].filter(Boolean))];
}

export function resolveDeepseekApiKey(env = process.env, preferredEnvName = "DEEPSEEK_API_KEY") {
  for (const name of deepseekCredentialEnvNames(preferredEnvName)) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function buildDeepseekClaudeEnv(
  baseEnv = process.env,
  { apiKeyEnv = "DEEPSEEK_API_KEY" } = {},
) {
  const apiKey = resolveDeepseekApiKey(baseEnv, apiKeyEnv);
  if (!apiKey) {
    const names = deepseekCredentialEnvNames(apiKeyEnv).join(", ");
    throw new Error(
      `Claude Code E2E requires a DeepSeek credential in one of: ${names}. ` +
      "Anthropic login is intentionally not used.",
    );
  }

  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_")) {
      delete env[name];
    }
  }

  Object.assign(env, {
    DEEPSEEK_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: DEEPSEEK_CLAUDE_MODELS.default,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_CLAUDE_MODELS.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_CLAUDE_MODELS.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_CLAUDE_MODELS.haiku,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  });

  return env;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function prepareDeepseekClaudeE2EEnv(
  baseEnv = process.env,
  { apiKeyEnv = "DEEPSEEK_API_KEY", runtimeDir } = {},
) {
  if (!runtimeDir) throw new Error("Claude Code E2E requires an isolated runtimeDir.");

  const env = buildDeepseekClaudeEnv(baseEnv, { apiKeyEnv });
  const sourcePath = baseEnv.PATH ?? "";
  const binDir = join(runtimeDir, "bin");
  const configDir = join(runtimeDir, "config");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const wrapperPath = join(binDir, "claude");
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nPATH=${shellQuote(sourcePath)}\nexport PATH\nclaude_path=$(command -v claude) || { echo 'Claude Code E2E requires claude on PATH.' >&2; exit 127; }\nexec "$claude_path" --setting-sources '' "$@"\n`,
    "utf8",
  );
  chmodSync(wrapperPath, 0o755);

  env.CLAUDE_CONFIG_DIR = configDir;
  env.PATH = `${binDir}${delimiter}${baseEnv.PATH ?? ""}`;
  return env;
}
