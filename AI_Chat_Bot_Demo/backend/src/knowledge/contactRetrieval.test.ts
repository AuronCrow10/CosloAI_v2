import { describe, expect, it, vi } from "vitest";
import { searchKnowledgeContacts } from "./contactRetrieval";

vi.mock("./client", () => ({
  searchKnowledgeWithMeta: vi.fn()
}));

import { searchKnowledgeWithMeta } from "./client";

describe("contact retrieval", () => {
  it("merges helper queries and raw query", async () => {
    const mock = searchKnowledgeWithMeta as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce({
        results: [{ id: "a", url: "https://site/contatti", chunkIndex: 0, text: "x", score: 0.9 }],
        retrievalStatus: "ok",
        noAnswerRecommended: false,
        confidence: { level: "high", score: 0.9 }
      })
      .mockResolvedValue({
        results: [],
        retrievalStatus: "low_confidence",
        noAnswerRecommended: true,
        confidence: { level: "low", score: 0 }
      });

    const result = await searchKnowledgeContacts({
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "it",
      retrievalParams: {},
      rawQuery: "email",
      includeRawQuery: true
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.debug?.rawMerged).toBe(true);
  });
});
