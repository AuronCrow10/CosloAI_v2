import { describe, expect, it } from "vitest";
import { classifyContactSource } from "./contactSourceClassification";

describe("classifyContactSource", () => {
  it("classifies contact urls as main", () => {
    expect(
      classifyContactSource({ url: "https://example.com/contatti", text: "" })
    ).toBe("main");
  });

  it("classifies partner urls as partner", () => {
    expect(
      classifyContactSource({ url: "https://example.com/partners", text: "" })
    ).toBe("partner");
  });
});
