import { describe, expect, it } from "vitest";
import { markSubagentTimedOut } from "../src/core/timeout.ts";
import type { SubagentToolDetails } from "../src/types.ts";

describe("subagent timeout helpers", () => {
  it("treats a late successful result as timed out once the timeout has fired", () => {
    const details: SubagentToolDetails = {
      description: "Late child",
      subagentType: "general-purpose",
      backend: "pi",
      status: "done",
      result: "late success after timeout",
      progress: {
        id: "late-child",
        description: "Late child",
        subagentType: "general-purpose",
        backend: "pi",
        status: "done",
        startedAt: 1,
        endedAt: 2,
        activity: [],
        activityCount: 0,
        result: "late success after timeout",
      },
    };

    const timedOut = markSubagentTimedOut(details, 20);

    expect(timedOut.status).toBe("aborted");
    expect(timedOut.error).toBe("Subagent timed out after 20ms");
    expect(timedOut.result).toBeUndefined();
    expect(timedOut.progress?.status).toBe("aborted");
    expect(timedOut.progress?.error).toBe("Subagent timed out after 20ms");
    expect(timedOut.progress?.result).toBeUndefined();
  });
});
