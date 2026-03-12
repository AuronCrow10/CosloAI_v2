import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing__, runKnowledgeRetrieval } from "./knowledgeOrchestration";

vi.mock("../knowledge/client", () => ({
  searchKnowledgeWithMeta: vi.fn()
}));

vi.mock("../knowledge/overviewRetrieval", () => ({
  searchKnowledgeOverview: vi.fn()
}));

import { searchKnowledgeWithMeta } from "../knowledge/client";
import { searchKnowledgeOverview } from "../knowledge/overviewRetrieval";

describe("runKnowledgeRetrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses overview retrieval when intent is overview", async () => {
    const overviewMock = searchKnowledgeOverview as unknown as ReturnType<typeof vi.fn>;
    const rawMock = searchKnowledgeWithMeta as unknown as ReturnType<typeof vi.fn>;
    overviewMock.mockResolvedValue({ results: [{ id: "o" }] });

    const result = await runKnowledgeRetrieval({
      intent: "overview",
      message: "Cosa sai?",
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "it",
      retrievalParams: {}
    });

    expect(result.source).toBe("overview_retrieval");
    expect(overviewMock).toHaveBeenCalled();
    expect(rawMock).not.toHaveBeenCalled();
  });

  it("uses raw retrieval when intent is specific", async () => {
    const overviewMock = searchKnowledgeOverview as unknown as ReturnType<typeof vi.fn>;
    const rawMock = searchKnowledgeWithMeta as unknown as ReturnType<typeof vi.fn>;
    rawMock.mockResolvedValue({ results: [], retrievalStatus: "ok" });

    const result = await runKnowledgeRetrieval({
      intent: "specific",
      message: "Prezzi?",
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "it",
      retrievalParams: {}
    });

    expect(result.source).toBe("raw_query_retrieval");
    expect(rawMock).toHaveBeenCalledTimes(2);
    const calledQueries = rawMock.mock.calls.map((call) => call[0]?.query);
    expect(calledQueries).toContain("Prezzi?");
    expect(calledQueries).toContain("prezzi listino costi prodotti servizi");
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("builds generic query variants without bot-specific hardcoding", () => {
    const variants = __testing__.buildSpecificQueryVariants({
      message: "avete i prezzi dei vostri prodotti?",
      ftsLanguage: "it"
    });

    expect(variants[0]).toBe("avete i prezzi dei vostri prodotti?");
    expect(variants).toContain("prezzi prodotti");
    expect(variants).toContain("prezzi listino costi prodotti servizi");
    expect(variants.length).toBeLessThanOrEqual(3);
  });

  it("merges multi-query results by keeping best scores", () => {
    const merged = __testing__.mergeRetrievalResponses({
      responses: [
        {
          retrievalStatus: "low_confidence",
          noAnswerRecommended: false,
          confidence: { level: "low", score: 0.41 },
          results: [
            {
              id: "a",
              clientId: "c1",
              domain: "example.com",
              url: "https://example.com/1",
              chunkIndex: 0,
              text: "first",
              score: 0.4,
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        },
        {
          retrievalStatus: "ok",
          noAnswerRecommended: false,
          confidence: { level: "medium", score: 0.72 },
          results: [
            {
              id: "a",
              clientId: "c1",
              domain: "example.com",
              url: "https://example.com/1",
              chunkIndex: 0,
              text: "first-better",
              score: 0.8,
              createdAt: "2026-01-01T00:00:00.000Z"
            },
            {
              id: "b",
              clientId: "c1",
              domain: "example.com",
              url: "https://example.com/2",
              chunkIndex: 0,
              text: "second",
              score: 0.7,
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        }
      ],
      maxResults: 5,
      queryVariants: ["q1", "q2"]
    });

    expect(merged.retrievalStatus).toBe("ok");
    expect(merged.confidence?.level).toBe("medium");
    expect(merged.results).toHaveLength(2);
    expect(merged.results[0]?.id).toBe("a");
    expect(merged.results[0]?.score).toBe(0.8);
  });

  it("tunes overview retrieval params for breadth and diversity", () => {
    const tuned = __testing__.tuneRetrievalParamsByIntent("overview", {
      candidateLimit: 30,
      finalLimit: 10,
      maxPerSource: 2
    });

    expect(tuned.diversifySources).toBe(true);
    expect(tuned.maxPerSource).toBe(1);
    expect(tuned.candidateLimit).toBeGreaterThanOrEqual(36);
    expect(tuned.finalLimit).toBeGreaterThanOrEqual(12);
    expect(tuned.adaptiveLimit).toBe(true);
  });

  it("keeps non-overview params largely unchanged", () => {
    const tuned = __testing__.tuneRetrievalParamsByIntent("specific", {
      candidateLimit: 20,
      finalLimit: 8,
      maxPerSource: 2,
      diversifySources: false
    });

    expect(tuned.candidateLimit).toBe(20);
    expect(tuned.finalLimit).toBe(8);
    expect(tuned.maxPerSource).toBe(2);
    expect(tuned.diversifySources).toBe(false);
  });
});
