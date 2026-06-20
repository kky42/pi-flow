import { describe, expect, it } from "vitest";

import { createBoundedBuffer } from "../src/core/stream.ts";

describe("createBoundedBuffer", () => {
  it("retains input below the cap verbatim", () => {
    const buffer = createBoundedBuffer(100);
    buffer.append("hello ");
    buffer.append("world");
    expect(buffer.overflowed()).toBe(false);
    expect(buffer.text()).toBe("hello world");
  });

  it("caps a single oversized append and marks truncation", () => {
    const buffer = createBoundedBuffer(8);
    buffer.append("0123456789");
    expect(buffer.overflowed()).toBe(true);
    expect(buffer.text()).toBe("0123\n…[truncated]\n6789");
  });

  it("caps across multiple appends and keeps the head plus tail", () => {
    const buffer = createBoundedBuffer(5);
    buffer.append("abc");
    buffer.append("defgh");
    buffer.append("ijkl");
    expect(buffer.overflowed()).toBe(true);
    expect(buffer.text()).toBe("abc\n…[truncated]\nkl");
  });

  it("treats an exact-cap fill as not overflowed", () => {
    const buffer = createBoundedBuffer(4);
    buffer.append("abcd");
    expect(buffer.overflowed()).toBe(false);
    expect(buffer.text()).toBe("abcd");
  });

  it("ignores empty chunks", () => {
    const buffer = createBoundedBuffer(4);
    buffer.append("");
    expect(buffer.text()).toBe("");
    expect(buffer.overflowed()).toBe(false);
  });
});
