import { describe, expect, it } from "vitest";
import { decideKnowledgePolicy } from "./knowledgeResponsePolicy";

describe("knowledge response policy", () => {
  it("routes overview intent to overview mode", () => {
    const policy = decideKnowledgePolicy({
      intent: "overview",
      retrieval: { retrievalStatus: "ok" },
      resultsCount: 2
    });
    expect(policy.mode).toBe("overview");
    expect(policy.responseStrategy).toBe("overview_summary");
    expect(policy.shouldCallAnswerLLM).toBe(true);
  });

  it("answers when evidence exists even if confidence is low", () => {
    const policy = decideKnowledgePolicy({
      intent: "specific",
      retrieval: { retrievalStatus: "low_confidence", confidence: { level: "low" } },
      resultsCount: 1
    });
    expect(policy.mode).toBe("specific");
    expect(policy.lowConfidence).toBe(true);
    expect(policy.responseStrategy).toBe("answer");
  });

  it("clarifies when no-answer is explicitly recommended", () => {
    const policy = decideKnowledgePolicy({
      intent: "specific",
      retrieval: {
        retrievalStatus: "low_confidence",
        confidence: { level: "low" },
        noAnswerRecommended: true
      },
      resultsCount: 2
    });
    expect(policy.mode).toBe("specific");
    expect(policy.responseStrategy).toBe("clarify");
  });

  it("routes ambiguous intent to ambiguous mode", () => {
    const policy = decideKnowledgePolicy({
      intent: "ambiguous",
      retrieval: null,
      resultsCount: 0
    });
    expect(policy.mode).toBe("ambiguous");
    expect(policy.responseStrategy).toBe("clarify");
    expect(policy.shouldCallAnswerLLM).toBe(true);
  });

  it("returns insufficient_info for overview with no results", () => {
    const policy = decideKnowledgePolicy({
      intent: "overview",
      retrieval: { retrievalStatus: "ok" },
      resultsCount: 0
    });
    expect(policy.mode).toBe("overview");
    expect(policy.responseStrategy).toBe("insufficient_info");
    expect(policy.shouldCallAnswerLLM).toBe(false);
  });
});
