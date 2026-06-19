export interface NormalizedAgentOptions {
  label?: string;
  phase?: string;
  subagentType?: string;
  schema?: unknown;
}

export function truncateLogLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

export function normalizeAgentOptions(value: unknown): NormalizedAgentOptions {
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

export function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

export function normalizeJsonSerializable(value: unknown, name: string): unknown {
  try {
    const normalized = normalizeJsonValue(value, name, new WeakSet<object>(), false);
    if (normalized === undefined) {
      throw new Error(`${name} is undefined; return null when there is intentionally no result`);
    }
    return normalized;
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`${name} must be JSON-serializable.${detail}`);
  }
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  insideArray: boolean,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
      return insideArray ? null : undefined;
    case "bigint":
    case "function":
    case "symbol":
      throw new Error(`${path} contains ${typeof value}`);
    case "object":
      break;
  }
  if (seen.has(value as object)) {
    throw new Error(`${path} contains a circular reference`);
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`, seen, true));
    }
    if (!isPlainJsonObject(value)) {
      const proto = Object.getPrototypeOf(value);
      throw new Error(`${path} contains non-plain object ${proto?.constructor?.name ?? "unknown"}`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeJsonValue(child, `${path}.${key}`, seen, false);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

function isPlainJsonObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || isObjectPrototype(proto);
}

function isObjectPrototype(value: object): boolean {
  if (value === Object.prototype) return true;
  const parent = Object.getPrototypeOf(value);
  const constructor = (value as { constructor?: unknown }).constructor;
  return parent === null && typeof constructor === "function" && constructor.name === "Object";
}
