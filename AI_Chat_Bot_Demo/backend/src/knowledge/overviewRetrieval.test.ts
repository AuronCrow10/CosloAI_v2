import { describe, expect, it, vi } from "vitest";
import { searchKnowledgeOverview } from "./overviewRetrieval";
import { getOverviewCoverageQueries } from "./overviewCoverageQueries";

vi.mock("./client", () => ({
  searchKnowledgeWithMeta: vi.fn()
}));

import { searchKnowledgeWithMeta } from "./client";

describe("overview retrieval", () => {
  it("uses language-specific helper queries", async () => {
    const mock = searchKnowledgeWithMeta as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      results: [],
      retrievalStatus: "low_confidence",
      noAnswerRecommended: true,
      confidence: { level: "low", score: 0 }
    });

    const queries = getOverviewCoverageQueries("it");
    await searchKnowledgeOverview({
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "it",
      retrievalParams: {}
    });

    const calledQueries = mock.mock.calls.map((call) => call[0]?.query);
    expect(calledQueries).toEqual(queries);
  });

  it("merges and dedupes results with source diversity", async () => {
    const mock = searchKnowledgeWithMeta as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce({
        results: [
          { id: "a", url: "https://site/a", chunkIndex: 0, text: "a", score: 0.9 }
        ],
        retrievalStatus: "ok",
        noAnswerRecommended: false,
        confidence: { level: "high", score: 0.9 }
      })
      .mockResolvedValueOnce({
        results: [
          { id: "a", url: "https://site/a", chunkIndex: 0, text: "a", score: 0.8 },
          { id: "b", url: "https://site/b", chunkIndex: 1, text: "b", score: 0.7 }
        ],
        retrievalStatus: "ok",
        noAnswerRecommended: false,
        confidence: { level: "medium", score: 0.6 }
      })
      .mockResolvedValue({
        results: [],
        retrievalStatus: "low_confidence",
        noAnswerRecommended: true,
        confidence: { level: "low", score: 0 }
      });

    const result = await searchKnowledgeOverview({
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "en",
      retrievalParams: {},
      maxResults: 3,
      maxPerSource: 1
    });

    expect(result.results.length).toBe(2);
    const urls = result.results.map((r) => r.url);
    expect(new Set(urls).size).toBe(2);
  });

  it("handles partial failures gracefully", async () => {
    const mock = searchKnowledgeWithMeta as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce({
        results: [
          { id: "x", url: "https://site/x", chunkIndex: 0, text: "x", score: 0.5 }
        ],
        retrievalStatus: "ok",
        noAnswerRecommended: false,
        confidence: { level: "medium", score: 0.5 }
      })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({
        results: [],
        retrievalStatus: "low_confidence",
        noAnswerRecommended: true,
        confidence: { level: "low", score: 0 }
      });

    const result = await searchKnowledgeOverview({
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "en",
      retrievalParams: {}
    });

    expect(result.results.length).toBe(1);
    expect(result.debug?.queriesSucceeded).toBeGreaterThan(0);
  });
});
