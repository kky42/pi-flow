import vm from "node:vm";
import { parse, type Node } from "acorn";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

/** A single agent() invocation requested by a workflow script. */
export interface WorkflowAgentCall {
  prompt: string;
  label: string;
  phase?: string;
  subagentType: string;
  /** Reserved for structured output (P4). */
  schema?: unknown;
}

/**
 * Runs one subagent and resolves with its final text. The workflow tool
 * supplies the real implementation (profile resolution + spawnSubagent); tests
 * inject a fake. Throwing is treated as a per-agent failure (the branch becomes
 * null and is logged) unless the workflow signal aborted.
 */
export type WorkflowAgentRunner = (
  call: WorkflowAgentCall,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

export interface RunWorkflowOptions {
  args?: unknown;
  cwd: string;
  signal?: AbortSignal;
  /** Shared global concurrency cap; agent() queues on this. */
  limiter: ConcurrencyLimiter;
  runAgent: WorkflowAgentRunner;
  defaultSubagentType?: string;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; subagentType: string; prompt: string }) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
}

interface NormalizedAgentOptions {
  label?: string;
  phase?: string;
  subagentType?: string;
  schema?: unknown;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

const DEFAULT_SUBAGENT_TYPE = "general-purpose";

export async function runWorkflow<T = unknown>(
  script: string,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<T>> {
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0 };
  const limiter = options.limiter;
  const defaultSubagentType = options.defaultSubagentType ?? DEFAULT_SUBAGENT_TYPE;

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw new Error("workflow aborted");
    }
  };

  const log = (message: unknown) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) {
      state.phases.push(text);
    }
    options.onPhase?.(text);
  };

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    const taskPrompt = requireString(prompt, "agent prompt");
    const opts = normalizeAgentOptions(agentOptions);
    const assignedPhase = opts.phase ?? state.currentPhase;
    const subagentType = opts.subagentType ?? defaultSubagentType;

    // Queue on the shared global cap. May reject if aborted while waiting.
    const release = await limiter.acquire(options.signal);
    state.agentCount++;
    const label = opts.label || defaultAgentLabel(assignedPhase, state.agentCount);
    options.onAgentStart?.({ label, phase: assignedPhase, subagentType, prompt: taskPrompt });
    try {
      throwIfAborted();
      const result = await options.runAgent(
        { prompt: taskPrompt, label, phase: assignedPhase, subagentType, schema: opts.schema },
        options.signal,
      );
      throwIfAborted();
      options.onAgentEnd?.({ label, phase: assignedPhase, result });
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
      return null;
    } finally {
      release();
    }
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) {
      throw new TypeError("parallel() expects an array of functions");
    }
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted) {
            throw error;
          }
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) {
      throw new TypeError("pipeline() expects an array as the first argument");
    }
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted) {
              throw error;
            }
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    cwd: options.cwd,
    process: Object.freeze({ cwd: () => options.cwd }),
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  });

  const wrapped = `(async () => {\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
  assertStructuredCloneable(result, "workflow result");

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as unknown as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) {
    throw new Error("meta must have a literal value");
  }

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }
  for (const child of astChildren(node)) {
    assertDeterministicAst(child);
  }
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      children.push(...value.filter(isAstNode));
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
    return false;
  }
  return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
    throw new Error("meta.whenToUse must be a string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): NormalizedAgentOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as Record<string, unknown>;
  return {
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    subagentType: optionalString(options.subagent_type, "agent subagent_type"),
    schema: options.schema,
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }
}
