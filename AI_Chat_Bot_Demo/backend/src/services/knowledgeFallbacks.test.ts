import { describe, expect, it } from "vitest";
import { getKnowledgeOverviewNoResultsMessage } from "./knowledgeFallbacks";

describe("knowledge overview no-results fallback", () => {
  it("returns Italian message for it", () => {
    const message = getKnowledgeOverviewNoResultsMessage("it");
    expect(message.toLowerCase()).toContain("contenuti indicizzati");
  });

  it("returns English message for en", () => {
    const message = getKnowledgeOverviewNoResultsMessage("en");
    expect(message.toLowerCase()).toContain("indexed content");
  });

  it("returns Spanish message for es", () => {
    const message = getKnowledgeOverviewNoResultsMessage("es");
    expect(message.toLowerCase()).toContain("contenido indexado");
  });

  it("falls back to English for unknown language", () => {
    const message = getKnowledgeOverviewNoResultsMessage("unknown");
    expect(message.toLowerCase()).toContain("indexed content");
  });
});
