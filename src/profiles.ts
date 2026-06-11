import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile, ThinkingLevel } from "./types.ts";

const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const BUNDLED_SUBAGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "subagents");

export function isValidSubagentName(name: string): boolean {
  return VALID_PROFILE_NAME.test(name);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined | "invalid" {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  if (typeof value !== "string") {
    return "invalid";
  }
  const normalized = value.trim() as ThinkingLevel;
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : "invalid";
}

function parseModel(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  const model = optionalString(value);
  if (!model) {
    return "invalid";
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1 || model.includes(" ")) {
    return "invalid";
  }
  return model;
}

function parseToolList(value: unknown): string[] | "invalid" {
  if (value === undefined || value === null) {
    return [];
  }
  const rawValues = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : "invalid";
  if (rawValues === "invalid") {
    return "invalid";
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      return "invalid";
    }
    const tool = rawValue.trim();
    if (!tool || seen.has(tool)) {
      continue;
    }
    seen.add(tool);
    tools.push(tool);
  }
  return tools;
}

function parseProfileFile(filePath: string, name: string, options: { requireBody: boolean }): SubagentProfile | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return undefined;
  }

  const description = optionalString(parsed.frontmatter.description);
  const body = parsed.body.trim();
  const model = parseModel(parsed.frontmatter.model);
  const thinking = parseThinking(parsed.frontmatter.thinking);
  const tools = Object.prototype.hasOwnProperty.call(parsed.frontmatter, "tools")
    ? parseToolList(parsed.frontmatter.tools)
    : undefined;

  if (!description || model === "invalid" || thinking === "invalid" || tools === "invalid" || (options.requireBody && !body)) {
    return undefined;
  }

  return {
    name,
    description,
    model,
    thinking,
    tools,
    systemPrompt: body || undefined,
  };
}

export function loadCustomSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  const dir = join(agentDir, "subagents");
  const profiles = new Map<string, SubagentProfile>();
  if (!existsSync(dir)) {
    return profiles;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return profiles;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const name = basename(entry, ".md");
    if (!isValidSubagentName(name)) {
      continue;
    }
    const profile = parseProfileFile(join(dir, entry), name, { requireBody: true });
    if (profile) {
      profiles.set(name, profile);
    }
  }

  return profiles;
}

export function loadBuiltinSubagentProfiles(dir = BUNDLED_SUBAGENTS_DIR): Map<string, SubagentProfile> {
  const profiles = new Map<string, SubagentProfile>();
  if (!existsSync(dir)) {
    return profiles;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return profiles;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const name = basename(entry, ".md");
    if (!isValidSubagentName(name)) {
      continue;
    }
    const profile = parseProfileFile(join(dir, entry), name, { requireBody: false });
    if (profile) {
      profiles.set(name, profile);
    }
  }

  return profiles;
}

export function getSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  return new Map([...loadBuiltinSubagentProfiles(), ...loadCustomSubagentProfiles(agentDir)]);
}
