import {
  buildClaudeArgs,
  claudeUsageToSubagentUsage,
  extractClaudeCostUsd,
  extractClaudeFinalText,
  extractClaudeUsage,
} from "../../../src/core/claude.ts";
import {
  buildCodexArgs,
  codexUsageToSubagentUsage,
  extractCodexFinalText,
  extractCodexUsage,
} from "../../../src/core/codex.ts";
import { formatUsage } from "../../../src/core/subagent-render.ts";

const expectedToken = (id) => `PI_FLOW_BASIC_E2E_OK:${id}`;

export const BASIC_METRICS_ROWS = Object.freeze([
  Object.freeze({
    id: "claude-deepseek-v4-flash",
    agent: "claude-code",
    model: "deepseek-v4-flash",
    invocationModel: "haiku",
    thinking: "medium",
    costPolicy: "allow-upstream-unknown",
    expectedToken: expectedToken("claude-deepseek-v4-flash"),
  }),
  Object.freeze({
    id: "codex-gpt-5.5",
    agent: "codex",
    model: "gpt-5.5",
    invocationModel: "gpt-5.5",
    thinking: "medium",
    costPolicy: "required",
    expectedToken: expectedToken("codex-gpt-5.5"),
  }),
  Object.freeze({
    id: "codex-gpt-5.6-luna",
    agent: "codex",
    model: "gpt-5.6-luna",
    invocationModel: "gpt-5.6-luna",
    thinking: "medium",
    costPolicy: "required",
    expectedToken: expectedToken("codex-gpt-5.6-luna"),
  }),
  Object.freeze({
    id: "pi-gpt-5.5",
    agent: "pi",
    model: "openai-codex/gpt-5.5",
    invocationModel: "openai-codex/gpt-5.5",
    thinking: "medium",
    costPolicy: "allow-upstream-unknown",
    expectedToken: expectedToken("pi-gpt-5.5"),
  }),
  Object.freeze({
    id: "pi-gpt-5.6-luna",
    agent: "pi",
    model: "openai-codex/gpt-5.6-luna",
    invocationModel: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    costPolicy: "allow-upstream-unknown",
    expectedToken: expectedToken("pi-gpt-5.6-luna"),
  }),
]);

export function buildProbeInvocation(row) {
  if (row.agent === "claude-code") {
    return {
      command: "claude",
      args: buildClaudeArgs({
        profile: { name: row.id, description: row.id, backend: "claude", model: row.invocationModel },
        thinkingLevel: row.thinking,
      }),
    };
  }
  if (row.agent === "codex") {
    return {
      command: "codex",
      args: buildCodexArgs({
        prompt: "",
        profile: { name: row.id, description: row.id, backend: "codex", model: row.invocationModel },
        thinkingLevel: row.thinking,
      }),
    };
  }
  return {
    command: "pi",
    args: [
      "-p",
      "--mode", "json",
      "--model", row.invocationModel,
      "--thinking", row.thinking,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--tools", "read",
      "--approve",
    ],
  };
}

export function parseJsonLines(text) {
  const events = [];
  const malformedLines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event !== null && typeof event === "object" && !Array.isArray(event)) events.push(event);
      else malformedLines.push(line);
    } catch {
      malformedLines.push(line);
    }
  }
  return { events, malformedLines };
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function normalizeCost(usage, costStatus) {
  const hasBillableTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
  if (hasBillableTokens && (!Number.isFinite(usage.cost) || usage.cost <= 0)) {
    return {
      ...usage,
      cost: 0,
      costKnown: false,
      costEstimated: false,
      costStatus: "unknown",
    };
  }
  return { ...usage, costStatus };
}

function summarizeClaude(events) {
  const resultEvent = [...events].reverse().find((event) => event?.type === "result");
  const rawUsage = resultEvent ? extractClaudeUsage(resultEvent) : undefined;
  const rawCost = resultEvent ? extractClaudeCostUsd(resultEvent) : undefined;
  const usage = rawUsage
    ? normalizeCost(claudeUsageToSubagentUsage(rawUsage, rawCost), "reported")
    : undefined;
  const modelUsage = asRecord(resultEvent?.modelUsage);
  const observedModels = unique([
    ...events.filter((event) => event?.type === "system" && event?.subtype === "init").map((event) => event.model),
    ...Object.keys(modelUsage ?? {}),
  ]);
  const toolCalls = events.reduce((count, event) => {
    if (event?.type !== "assistant") return count;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    return count + content.filter((part) => part?.type === "tool_use").length;
  }, 0);
  const toolErrors = events.reduce((count, event) => {
    if (event?.type === "tool_result" && event?.is_error === true) return count + 1;
    if (event?.type !== "user") return count;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    return count + content.filter((part) => part?.type === "tool_result" && part?.is_error === true).length;
  }, 0);
  const finalText = resultEvent ? extractClaudeFinalText(resultEvent) ?? "" : "";
  return {
    completed: resultEvent?.subtype === "success" && resultEvent?.is_error !== true,
    finalText,
    observedModels,
    toolCalls,
    toolErrors,
    usage,
  };
}

function summarizeCodex(row, events) {
  const usageEvent = [...events].reverse().find((event) => extractCodexUsage(event) !== undefined);
  const rawUsage = usageEvent ? extractCodexUsage(usageEvent) : undefined;
  const usage = rawUsage
    ? normalizeCost(codexUsageToSubagentUsage(row.model, rawUsage), "estimated")
    : undefined;
  const finalText = events.map(extractCodexFinalText).filter((text) => text !== undefined).at(-1) ?? "";
  const toolItems = events
    .filter((event) => event?.type === "item.completed")
    .map((event) => asRecord(event.item))
    .filter((item) => item && item.type !== "agent_message");
  const toolErrors = toolItems.filter((item) => item?.status === "failed" || item?.is_error === true).length;
  return {
    completed: events.some((event) => event?.type === "turn.completed") && !events.some((event) => event?.type === "turn.failed"),
    finalText,
    observedModels: [row.model],
    toolCalls: toolItems.length,
    toolErrors,
    usage,
  };
}

function summarizePi(events) {
  const assistantMessages = events
    .filter((event) => event?.type === "message_end" && event?.message?.role === "assistant")
    .map((event) => event.message);
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    sawUsage: false,
    sawPositiveCost: false,
  };
  for (const message of assistantMessages) {
    const usage = asRecord(message.usage);
    if (!usage) continue;
    const input = asFiniteNumber(usage.input);
    const output = asFiniteNumber(usage.output);
    const cacheRead = asFiniteNumber(usage.cacheRead ?? 0);
    const cacheWrite = asFiniteNumber(usage.cacheWrite ?? 0);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) continue;
    totals.sawUsage = true;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    const cost = asFiniteNumber(asRecord(usage.cost)?.total);
    if (cost !== undefined) {
      totals.cost += cost;
      if (cost > 0) totals.sawPositiveCost = true;
    }
  }
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  const usage = totals.sawUsage
    ? normalizeCost({
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      cost: totals.cost,
      costKnown: totals.sawPositiveCost,
      costEstimated: false,
      cacheHitRate: promptTokens > 0 ? totals.cacheRead / promptTokens * 100 : undefined,
    }, "reported")
    : undefined;
  const observedModels = unique(assistantMessages.map((message) => {
    if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
    return `${message.provider}/${message.model}`;
  }));
  const toolEvents = events.filter((event) => event?.type === "tool_execution_end");
  const finalText = contentText(assistantMessages.at(-1)?.content);
  return {
    completed: events.some((event) => event?.type === "agent_end") && assistantMessages.at(-1)?.stopReason !== "error",
    finalText,
    observedModels,
    toolCalls: toolEvents.length,
    toolErrors: toolEvents.filter((event) => event?.isError === true).length,
    usage,
  };
}

function modelWasObserved(row, observedModels) {
  if (row.agent === "codex") return observedModels.includes(row.model);
  return observedModels.some((model) => model === row.model || model.includes(row.model));
}

function usageErrors(usage, usageDisplay) {
  if (!usage) return ["usage telemetry missing"];
  const errors = [];
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!Number.isFinite(usage[key]) || usage[key] < 0) errors.push(`${key} token telemetry invalid`);
  }
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) errors.push("input token telemetry missing");
  if (usage.output <= 0) errors.push("output token telemetry missing");
  if (!Number.isFinite(usage.cacheHitRate)) errors.push("cache-hit telemetry missing");
  if (!usageDisplay.includes("↑") || !usageDisplay.includes("↓") || !usageDisplay.includes("CH")) {
    errors.push("formatted usage telemetry incomplete");
  }
  return errors;
}

export function summarizeProbe({ row, events, durationMs, processResult }) {
  const backend = row.agent === "claude-code"
    ? summarizeClaude(events)
    : row.agent === "codex"
      ? summarizeCodex(row, events)
      : summarizePi(events);
  const usageDisplay = backend.usage ? formatUsage(backend.usage) : "";
  const errors = [];
  const warnings = [];

  if (processResult.timedOut) errors.push("process timed out");
  if (processResult.code !== 0) errors.push(`process exited with code ${processResult.code}`);
  if (!backend.completed) errors.push("agent completion event missing or failed");
  if (!backend.finalText.includes(row.expectedToken)) errors.push("expected result token missing");
  if (backend.toolCalls < 1) errors.push("read tool activity missing");
  if (backend.toolErrors > 0) errors.push("tool execution failed");
  if (!modelWasObserved(row, backend.observedModels)) errors.push("requested model was not observed");
  errors.push(...usageErrors(backend.usage, usageDisplay));

  if (backend.usage) {
    if (backend.usage.costStatus === "unknown") {
      if (row.costPolicy === "required") errors.push("cost telemetry missing for locally priced model");
      else warnings.push("cost unavailable from upstream pricing metadata");
    } else if (!usageDisplay.includes("$")) {
      errors.push("formatted cost telemetry missing");
    }
  }

  const usage = backend.usage;
  const tokensValid = usage !== undefined &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((value) => Number.isFinite(value) && value >= 0) &&
    usage.input + usage.cacheRead + usage.cacheWrite > 0 &&
    usage.output > 0;
  const cacheHitRateValid = usage !== undefined &&
    Number.isFinite(usage.cacheHitRate) &&
    usage.cacheHitRate >= 0 &&
    usage.cacheHitRate <= 100;
  const displayValid = usage !== undefined &&
    usageDisplay.includes("↑") &&
    usageDisplay.includes("↓") &&
    usageDisplay.includes("CH") &&
    usageDisplay.includes("$");
  const costCheck = usage === undefined
    ? "fail"
    : usage.costStatus === "unknown"
      ? row.costPolicy === "required" ? "fail" : "warn"
      : usage.cost > 0 && usageDisplay.includes("$") ? "pass" : "fail";
  const checks = {
    process: !processResult.timedOut && processResult.code === 0 ? "pass" : "fail",
    completion: backend.completed ? "pass" : "fail",
    model: modelWasObserved(row, backend.observedModels) ? "pass" : "fail",
    tool: backend.toolCalls > 0 && backend.toolErrors === 0 ? "pass" : "fail",
    result: backend.finalText.includes(row.expectedToken) ? "pass" : "fail",
    usage: usage ? "pass" : "fail",
    tokens: tokensValid ? "pass" : "fail",
    cacheHitRate: cacheHitRateValid ? "pass" : "fail",
    cost: costCheck,
    display: displayValid ? "pass" : "fail",
  };

  return {
    id: row.id,
    agent: row.agent,
    model: row.model,
    thinking: row.thinking,
    durationMs,
    status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    observedModels: backend.observedModels,
    toolCalls: backend.toolCalls,
    toolErrors: backend.toolErrors,
    resultTokenFound: backend.finalText.includes(row.expectedToken),
    usage: usage ? {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      cacheHitRate: usage.cacheHitRate,
      costUsd: usage.cost,
      costStatus: usage.costStatus,
    } : undefined,
    usageDisplay,
    checks,
    warnings,
    errors,
  };
}
