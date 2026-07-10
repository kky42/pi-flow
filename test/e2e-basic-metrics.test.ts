import { describe, expect, it } from "vitest";
import {
  BASIC_METRICS_ROWS,
  buildProbeInvocation,
  parseJsonLines,
  summarizeProbe,
} from "../scripts/e2e/lib/basic-metrics.mjs";

describe("basic metrics semi-E2E reporting", () => {
  it("defines the requested agent and model matrix", () => {
    expect(BASIC_METRICS_ROWS.map(({ id, agent, model, thinking }) => ({ id, agent, model, thinking }))).toEqual([
      { id: "claude-deepseek-v4-flash", agent: "claude-code", model: "deepseek-v4-flash", thinking: "medium" },
      { id: "codex-gpt-5.5", agent: "codex", model: "gpt-5.5", thinking: "medium" },
      { id: "codex-gpt-5.6-luna", agent: "codex", model: "gpt-5.6-luna", thinking: "medium" },
      { id: "pi-gpt-5.5", agent: "pi", model: "openai-codex/gpt-5.5", thinking: "medium" },
      { id: "pi-gpt-5.6-luna", agent: "pi", model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
    ]);
  });

  it("builds each harness invocation with the requested model and medium thinking", () => {
    const claude = buildProbeInvocation(BASIC_METRICS_ROWS[0]);
    expect(claude.command).toBe("claude");
    expect(claude.args).toContain("stream-json");
    expect(claude.args).toContain("haiku");
    expect(claude.args).toContain("medium");

    const codex55 = buildProbeInvocation(BASIC_METRICS_ROWS[1]);
    expect(codex55.command).toBe("codex");
    expect(codex55.args).toContain("gpt-5.5");
    expect(codex55.args).toContain("model_reasoning_effort=\"medium\"");

    const codex56 = buildProbeInvocation(BASIC_METRICS_ROWS[2]);
    expect(codex56.args).toContain("gpt-5.6-luna");

    const pi55 = buildProbeInvocation(BASIC_METRICS_ROWS[3]);
    expect(pi55.command).toBe("pi");
    expect(pi55.args).toContain("openai-codex/gpt-5.5");
    expect(pi55.args).toContain("medium");
    expect(pi55.args).toContain("read");

    const pi56 = buildProbeInvocation(BASIC_METRICS_ROWS[4]);
    expect(pi56.args).toContain("openai-codex/gpt-5.6-luna");
  });

  it("parses JSONL while preserving malformed-line diagnostics", () => {
    expect(parseJsonLines('{"type":"ok"}\nnot-json\n\n')).toEqual({
      events: [{ type: "ok" }],
      malformedLines: ["not-json"],
    });
  });

  it("reports complete Claude Code functionality and telemetry", () => {
    const row = BASIC_METRICS_ROWS[0];
    const summary = summarizeProbe({
      row,
      durationMs: 1234,
      processResult: { code: 0, signal: null, timedOut: false },
      events: [
        {
          type: "system",
          subtype: "init",
          session_id: "claude-session",
          model: "deepseek-v4-flash[1m]",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", input: { file_path: "e2e-target.txt" } }],
            usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20 },
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: row.expectedToken,
          total_cost_usd: 0.012,
          modelUsage: {
            "deepseek-v4-flash[1m]": {
              inputTokens: 100,
              cacheReadInputTokens: 50,
              cacheCreationInputTokens: 10,
              outputTokens: 20,
              costUSD: 0.012,
            },
          },
        },
      ],
    });

    expect(summary.status).toBe("pass");
    expect(summary.observedModels).toEqual(["deepseek-v4-flash[1m]"]);
    expect(summary.toolCalls).toBe(1);
    expect(summary.usage).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      cacheHitRate: 31.25,
      costUsd: 0.012,
      costStatus: "reported",
    });
    expect(summary.usageDisplay).toBe("↑100 ↓20 R50 W10 CH31.3% $0.012");
    expect(summary.checks).toEqual({
      process: "pass",
      completion: "pass",
      model: "pass",
      tool: "pass",
      result: "pass",
      usage: "pass",
      tokens: "pass",
      cacheHitRate: "pass",
      cost: "pass",
      display: "pass",
    });
    expect(summary.errors).toEqual([]);
  });

  it("fails a Claude row when the real tool-result shape reports an error", () => {
    const row = BASIC_METRICS_ROWS[0];
    const summary = summarizeProbe({
      row,
      durationMs: 100,
      processResult: { code: 0, signal: null, timedOut: false },
      events: [
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
        { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: row.expectedToken,
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
        },
      ],
    });

    expect(summary.status).toBe("fail");
    expect(summary.checks.tool).toBe("fail");
    expect(summary.errors).toContain("tool execution failed");
  });

  it("requires estimated cost for locally priced Codex models", () => {
    const row = BASIC_METRICS_ROWS[1];
    const summary = summarizeProbe({
      row,
      durationMs: 900,
      processResult: { code: 0, signal: null, timedOut: false },
      events: [
        { type: "thread.started", thread_id: "codex-session" },
        { type: "item.completed", item: { type: "command_execution", command: "cat e2e-target.txt" } },
        { type: "item.completed", item: { type: "agent_message", text: row.expectedToken } },
        { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } },
      ],
    });

    expect(summary.status).toBe("pass");
    expect(summary.toolCalls).toBe(1);
    expect(summary.usage).toMatchObject({
      input: 600,
      output: 50,
      cacheRead: 400,
      cacheWrite: 0,
      cacheHitRate: 40,
      costUsd: 0.0013,
      costStatus: "estimated",
    });
    expect(summary.usageDisplay).toBe("↑600 ↓50 R400 CH40.0% $0.001");
  });

  it("aggregates Pi assistant usage and verifies the observed model", () => {
    const row = BASIC_METRICS_ROWS[3];
    const summary = summarizeProbe({
      row,
      durationMs: 750,
      processResult: { code: 0, signal: null, timedOut: false },
      events: [
        { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false },
        {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.5",
            content: [{ type: "text", text: row.expectedToken }],
            usage: {
              input: 100,
              output: 20,
              cacheRead: 40,
              cacheWrite: 10,
              totalTokens: 170,
              cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
            },
            stopReason: "stop",
          },
        },
        { type: "agent_end", messages: [] },
      ],
    });

    expect(summary.status).toBe("pass");
    expect(summary.observedModels).toEqual(["openai-codex/gpt-5.5"]);
    expect(summary.usage).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 40,
      cacheWrite: 10,
      cacheHitRate: 40 / 150 * 100,
      costUsd: 0.002,
      costStatus: "reported",
    });
    expect(summary.usageDisplay).toBe("↑100 ↓20 R40 W10 CH26.7% $0.002");
  });

  it("warns for allowed upstream price gaps but fails missing usage", () => {
    const row = BASIC_METRICS_ROWS[0];
    const unknownCost = summarizeProbe({
      row,
      durationMs: 500,
      processResult: { code: 0, signal: null, timedOut: false },
      events: [
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: row.expectedToken,
          total_cost_usd: 0,
          modelUsage: {
            "deepseek-v4-flash[1m]": {
              inputTokens: 100,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 10,
              costUSD: 0,
            },
          },
        },
      ],
    });

    expect(unknownCost.status).toBe("warn");
    expect(unknownCost.usage?.costStatus).toBe("unknown");
    expect(unknownCost.usageDisplay).toBe("↑100 ↓10 CH0.0% $?");
    expect(unknownCost.checks.cost).toBe("warn");
    expect(unknownCost.warnings).toContain("cost unavailable from upstream pricing metadata");

    const missingUsage = summarizeProbe({
      row,
      durationMs: 500,
      processResult: { code: 0, signal: null, timedOut: false },
      events: [
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } },
        { type: "result", subtype: "success", is_error: false, result: row.expectedToken },
      ],
    });

    expect(missingUsage.status).toBe("fail");
    expect(missingUsage.checks.usage).toBe("fail");
    expect(missingUsage.checks.tokens).toBe("fail");
    expect(missingUsage.checks.cacheHitRate).toBe("fail");
    expect(missingUsage.errors).toContain("usage telemetry missing");
  });
});
