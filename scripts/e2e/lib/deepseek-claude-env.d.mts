export const DEEPSEEK_ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic";
export const DEEPSEEK_CLAUDE_MODELS: Readonly<{
  default: "deepseek-v4-pro[1m]";
  opus: "deepseek-v4-pro[1m]";
  sonnet: "deepseek-v4-pro[1m]";
  haiku: "deepseek-v4-flash[1m]";
}>;

export function loadDotEnv<T extends Record<string, string | undefined>>(
  filePath: string,
  env?: T,
): T;

export function deepseekCredentialEnvNames(preferredEnvName?: string): string[];

export function resolveDeepseekApiKey(
  env?: Record<string, string | undefined>,
  preferredEnvName?: string,
): string | undefined;

export function buildDeepseekClaudeEnv(
  baseEnv?: Record<string, string | undefined>,
  options?: { apiKeyEnv?: string },
): Record<string, string | undefined>;

export function prepareDeepseekClaudeE2EEnv(
  baseEnv?: Record<string, string | undefined>,
  options?: { apiKeyEnv?: string; runtimeDir?: string },
): Record<string, string | undefined>;
