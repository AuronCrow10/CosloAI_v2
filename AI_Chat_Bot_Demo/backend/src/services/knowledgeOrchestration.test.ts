import { describe, expect, it, vi } from "vitest";
import { runKnowledgeRetrieval } from "./knowledgeOrchestration";

vi.mock("../knowledge/client", () => ({
  searchKnowledgeWithMeta: vi.fn()
}));

vi.mock("../knowledge/overviewRetrieval", () => ({
  searchKnowledgeOverview: vi.fn()
}));

import { searchKnowledgeWithMeta } from "../knowledge/client";
import { searchKnowledgeOverview } from "../knowledge/overviewRetrieval";

describe("runKnowledgeRetrieval", () => {
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
    rawMock.mockResolvedValue({ results: [] });

    const result = await runKnowledgeRetrieval({
      intent: "specific",
      message: "Prezzi?",
      clientId: "c1",
      domain: "example.com",
      ftsLanguage: "it",
      retrievalParams: {}
    });

    expect(result.source).toBe("raw_query_retrieval");
    expect(rawMock).toHaveBeenCalled();
    expect(overviewMock).not.toHaveBeenCalled();
  });
});
