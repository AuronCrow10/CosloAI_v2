import { describe, expect, it } from "vitest";
import {
  getKnowledgeRetrievalParams,
  resolveKnowledgeRetrievalProfile
} from "./knowledgeRetrievalProfiles";

describe("knowledgeRetrievalProfiles", () => {
  it("resolves invalid values to balanced", () => {
    expect(resolveKnowledgeRetrievalProfile(undefined)).toBe("balanced");
    expect(resolveKnowledgeRetrievalProfile("invalid")).toBe("balanced");
    expect(resolveKnowledgeRetrievalProfile("PRECISE")).toBe("precise");
  });

  it("returns exact params for balanced profile", () => {
    expect(getKnowledgeRetrievalParams("balanced")).toEqual({
      strategy: "hybrid",
      candidateLimit: 30,
      finalLimit: 10,
      includeAdjacent: true,
      adjacentWindow: 1,
      stitchChunks: true,
      dedupeResults: true,
      diversifySources: true,
      maxPerSource: 2,
      nearDuplicateThreshold: 0.85,
      adaptiveLimit: true,
      minLimit: 3,
      maxLimit: 5,
      contextTokenBudget: 1500,
      minConfidenceLevel: "medium",
      noAnswerOnLowConfidence: false,
      returnDebug: false
    });
  });

  it("returns exact params for precise profile", () => {
    expect(getKnowledgeRetrievalParams("precise")).toEqual({
      strategy: "hybrid",
      candidateLimit: 25,
      finalLimit: 8,
      includeAdjacent: true,
      adjacentWindow: 1,
      stitchChunks: true,
      dedupeResults: true,
      diversifySources: true,
      maxPerSource: 1,
      nearDuplicateThreshold: 0.85,
      adaptiveLimit: true,
      minLimit: 2,
      maxLimit: 4,
      contextTokenBudget: 1000,
      minConfidenceLevel: "medium",
      noAnswerOnLowConfidence: false,
      returnDebug: false
    });
  });

  it("returns exact params for broad profile", () => {
    expect(getKnowledgeRetrievalParams("broad")).toEqual({
      strategy: "hybrid",
      candidateLimit: 40,
      finalLimit: 12,
      includeAdjacent: true,
      adjacentWindow: 1,
      stitchChunks: true,
      dedupeResults: true,
      diversifySources: true,
      maxPerSource: 2,
      nearDuplicateThreshold: 0.9,
      adaptiveLimit: true,
      minLimit: 4,
      maxLimit: 6,
      contextTokenBudget: 1800,
      minConfidenceLevel: "medium",
      noAnswerOnLowConfidence: false,
      returnDebug: false
    });
  });
});
