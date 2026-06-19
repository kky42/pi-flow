import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseWorkflowScript } from "./script-validation.ts";
import type { WorkflowMeta } from "./types.ts";

const VALID_SAVED_WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const WORKFLOW_FILE_EXTENSION = ".js";
const GLOBAL_WORKFLOWS_DIR = "workflows";
const PROJECT_WORKFLOWS_DIR = join(".pi", "workflows");

export type SavedWorkflowScope = "global" | "project";
export type WorkflowPathScope = SavedWorkflowScope | "session";

export interface SavedWorkflow {
  name: string;
  description: string;
  scope: SavedWorkflowScope;
  path: string;
  root: string;
  script: string;
  meta: WorkflowMeta;
}

export interface SavedWorkflowRegistry {
  workflows: Map<string, SavedWorkflow>;
  warnings: string[];
}

export interface LoadSavedWorkflowOptions {
  agentDir?: string;
  cwd: string;
  projectTrusted?: boolean;
}

interface WorkflowRoot {
  scope: SavedWorkflowScope;
  path: string;
}

interface WorkflowPathRoot {
  scope: WorkflowPathScope;
  path: string;
}

export interface LoadWorkflowScriptPathOptions extends LoadSavedWorkflowOptions {
  sessionWorkflowDir?: string;
}

export interface LoadedWorkflowScriptPath {
  path: string;
  root: string;
  scope: WorkflowPathScope;
  script: string;
  meta: WorkflowMeta;
}

export type LoadWorkflowScriptPathResult =
  | { ok: true; workflow: LoadedWorkflowScriptPath; warnings: string[] }
  | { ok: false; message: string; warnings: string[] };

export function isValidSavedWorkflowName(name: string): boolean {
  return VALID_SAVED_WORKFLOW_NAME.test(name);
}

export function getSavedWorkflowRoots(options: LoadSavedWorkflowOptions): WorkflowRoot[] {
  const agentDir = options.agentDir ?? getAgentDir();
  const roots: WorkflowRoot[] = [{ scope: "global", path: join(agentDir, GLOBAL_WORKFLOWS_DIR) }];
  if (options.projectTrusted) {
    roots.push({ scope: "project", path: join(options.cwd, PROJECT_WORKFLOWS_DIR) });
  }
  return roots;
}

function getWorkflowPathRoots(options: LoadWorkflowScriptPathOptions): WorkflowPathRoot[] {
  const roots: WorkflowPathRoot[] = [...getSavedWorkflowRoots(options)];
  if (options.sessionWorkflowDir) {
    roots.push({ scope: "session", path: options.sessionWorkflowDir });
  }
  return roots;
}

export function loadSavedWorkflowRegistry(options: LoadSavedWorkflowOptions): SavedWorkflowRegistry {
  const workflows = new Map<string, SavedWorkflow>();
  const warnings: string[] = [];

  for (const root of getSavedWorkflowRoots(options)) {
    const rootRealPath = safeRealDirectory(root.path);
    if (!rootRealPath) {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(rootRealPath).sort();
    } catch (error) {
      warnings.push(`Could not read ${root.scope} workflows at ${root.path}: ${errorMessage(error)}`);
      continue;
    }

    for (const entry of entries) {
      if (extname(entry) !== WORKFLOW_FILE_EXTENSION) {
        continue;
      }
      const filePath = join(rootRealPath, entry);
      const workflow = loadSavedWorkflowFile(filePath, rootRealPath, root.scope, warnings);
      if (workflow) {
        workflows.set(workflow.name, workflow);
      }
    }
  }

  return { workflows, warnings };
}

export function listSavedWorkflows(options: LoadSavedWorkflowOptions): SavedWorkflow[] {
  return [...loadSavedWorkflowRegistry(options).workflows.values()].sort(compareSavedWorkflows);
}

export function loadWorkflowScriptPath(
  scriptPath: string,
  options: LoadWorkflowScriptPathOptions,
): LoadWorkflowScriptPathResult {
  const warnings: string[] = [];
  if (extname(scriptPath) !== WORKFLOW_FILE_EXTENSION) {
    return { ok: false, message: `Workflow scriptPath must point to a ${WORKFLOW_FILE_EXTENSION} file.`, warnings };
  }

  let realPath: string;
  try {
    const candidate = isAbsolute(scriptPath) ? scriptPath : resolve(options.cwd, scriptPath);
    realPath = realpathSync(candidate);
  } catch (error) {
    return { ok: false, message: `Could not resolve workflow scriptPath ${scriptPath}: ${errorMessage(error)}`, warnings };
  }

  if (extname(realPath) !== WORKFLOW_FILE_EXTENSION) {
    return { ok: false, message: `Workflow scriptPath must resolve to a ${WORKFLOW_FILE_EXTENSION} file.`, warnings };
  }

  const roots = getWorkflowPathRoots(options)
    .map((root) => ({ ...root, realPath: safeRealDirectory(root.path) }))
    .filter((root): root is WorkflowPathRoot & { realPath: string } => Boolean(root.realPath));
  const root = roots.find((candidate) => isInsideRoot(realPath, candidate.realPath));
  if (!root) {
    return {
      ok: false,
      message: `Workflow scriptPath is outside allowed workflow roots: ${scriptPath}`,
      warnings,
    };
  }

  try {
    if (!statSync(realPath).isFile()) {
      return { ok: false, message: `Workflow scriptPath is not a file: ${scriptPath}`, warnings };
    }
  } catch (error) {
    return { ok: false, message: `Could not stat workflow scriptPath ${scriptPath}: ${errorMessage(error)}`, warnings };
  }

  let script: string;
  try {
    script = readFileSync(realPath, "utf8");
  } catch (error) {
    return { ok: false, message: `Could not read workflow scriptPath ${scriptPath}: ${errorMessage(error)}`, warnings };
  }

  try {
    const meta = parseWorkflowScript(script).meta;
    const name = meta.name.trim();
    if (root.scope !== "session" && !isValidSavedWorkflowName(name)) {
      return {
        ok: false,
        message: `Workflow scriptPath is invalid: meta.name must match ${VALID_SAVED_WORKFLOW_NAME}`,
        warnings,
      };
    }
    return { ok: true, workflow: { path: realPath, root: root.realPath, scope: root.scope, script, meta }, warnings };
  } catch (error) {
    return {
      ok: false,
      message: `Workflow scriptPath is invalid: ${errorMessage(error)}`,
      warnings,
    };
  }
}

function loadSavedWorkflowFile(
  filePath: string,
  rootRealPath: string,
  scope: SavedWorkflowScope,
  warnings: string[],
): SavedWorkflow | undefined {
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch (error) {
    warnings.push(`Could not resolve workflow ${filePath}: ${errorMessage(error)}`);
    return undefined;
  }

  if (!isInsideRoot(realPath, rootRealPath)) {
    warnings.push(`Skipped workflow outside ${scope} workflow root: ${filePath}`);
    return undefined;
  }

  try {
    if (!statSync(realPath).isFile()) {
      return undefined;
    }
  } catch (error) {
    warnings.push(`Could not stat workflow ${realPath}: ${errorMessage(error)}`);
    return undefined;
  }

  let script: string;
  try {
    script = readFileSync(realPath, "utf8");
  } catch (error) {
    warnings.push(`Could not read workflow ${realPath}: ${errorMessage(error)}`);
    return undefined;
  }

  let meta: WorkflowMeta;
  try {
    meta = parseWorkflowScript(script).meta;
  } catch (error) {
    warnings.push(`Skipped invalid workflow ${realPath}: ${errorMessage(error)}`);
    return undefined;
  }

  const name = meta.name.trim();
  if (!isValidSavedWorkflowName(name)) {
    warnings.push(`Skipped workflow ${realPath}: meta.name must match ${VALID_SAVED_WORKFLOW_NAME}`);
    return undefined;
  }

  return {
    name,
    description: meta.description.trim(),
    scope,
    path: realPath,
    root: rootRealPath,
    script,
    meta,
  };
}

function safeRealDirectory(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    if (lstatSync(path).isSymbolicLink()) {
      return undefined;
    }
    const realPath = realpathSync(path);
    return statSync(realPath).isDirectory() ? realPath : undefined;
  } catch {
    return undefined;
  }
}

function isInsideRoot(realPath: string, rootRealPath: string): boolean {
  const rel = relative(rootRealPath, realPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function compareSavedWorkflows(a: SavedWorkflow, b: SavedWorkflow): number {
  return a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
