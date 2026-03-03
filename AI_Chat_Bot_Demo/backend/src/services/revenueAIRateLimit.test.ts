import { describe, expect, it, vi } from "vitest";
import { createDedupeWindow, createSlidingWindowLimiter } from "./revenueAIRateLimit";

describe("revenueAIRateLimit", () => {
  it("enforces sliding window limits", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 2 });
    expect(limiter.allow("ip")).toBe(true);
    expect(limiter.allow("ip")).toBe(true);
    expect(limiter.allow("ip")).toBe(false);
  });

  it("dedupes within the window", () => {
    const dedupe = createDedupeWindow({ windowMs: 1000 });
    expect(dedupe.isDuplicate("key")).toBe(false);
    expect(dedupe.isDuplicate("key")).toBe(true);
  });
});
