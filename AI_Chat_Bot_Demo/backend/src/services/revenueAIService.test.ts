import { describe, expect, it } from "vitest";
import { computeStyleUsed } from "./revenueAIService";

describe("computeStyleUsed", () => {
  it("uses override when mode is AUTO", () => {
    const style = computeStyleUsed({
      mode: "AUTO",
      assignedStyle: "SOFT",
      overrideStyle: "CLOSER"
    });
    expect(style).toBe("CLOSER");
  });

  it("uses assigned style when mode is AUTO and no override", () => {
    const style = computeStyleUsed({
      mode: "AUTO",
      assignedStyle: "CLOSER",
      overrideStyle: null
    });
    expect(style).toBe("CLOSER");
  });

  it("ignores override when mode forces SOFT", () => {
    const style = computeStyleUsed({
      mode: "SOFT",
      assignedStyle: "CLOSER",
      overrideStyle: "CLOSER"
    });
    expect(style).toBe("SOFT");
  });
});
