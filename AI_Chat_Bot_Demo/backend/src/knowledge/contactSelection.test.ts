import { describe, expect, it } from "vitest";
import type { KnowledgeSearchResult } from "./client";
import { selectContactExtractionPool } from "./contactSelection";
import { extractContacts } from "./contactExtraction";
import { selectBestGenericContactSource } from "./contactSelection";

const mainContact: KnowledgeSearchResult = {
  id: "main-1",
  clientId: "c1",
  domain: "example.com",
  url: "https://example.com/contatti",
  chunkIndex: 0,
  text: "Email: info@example.com Tel: +39 333 111 2222",
  createdAt: "2026-01-01T00:00:00Z",
  score: 0.9
};

const partnerContact: KnowledgeSearchResult = {
  id: "partner-1",
  clientId: "c1",
  domain: "example.com",
  url: "https://example.com/partners/abc",
  chunkIndex: 0,
  text: "Partner email: partner@example.com Tel: +39 333 999 8888",
  createdAt: "2026-01-01T00:00:00Z",
  score: 0.8
};

describe("contact selection", () => {
  it("generic contact picks main contact over partner", () => {
    const selection = selectContactExtractionPool({
      results: [partnerContact, mainContact],
      preferPartnerSources: false
    });

    const extracted = extractContacts({
      sources: selection.pool.map((r) => ({ text: r.text, url: r.url, trusted: true }))
    });

    expect(extracted.emails).toContain("info@example.com");
    expect(extracted.emails).not.toContain("partner@example.com");
    expect(selection.trustedIds.has(mainContact.id)).toBe(true);
    expect(selection.trustedIds.has(partnerContact.id)).toBe(false);
  });

  it("partner contact query can use partner sources", () => {
    const selection = selectContactExtractionPool({
      results: [partnerContact],
      preferPartnerSources: true
    });

    const extracted = extractContacts({
      sources: selection.pool.map((r) => ({ text: r.text, url: r.url, trusted: true }))
    });

    expect(extracted.emails).toContain("partner@example.com");
    expect(selection.trustedIds.has(partnerContact.id)).toBe(true);
  });

  it("generic selection prefers contact page source over noisy source", () => {
    const selection = selectContactExtractionPool({
      results: [partnerContact, mainContact],
      preferPartnerSources: false
    });

    const candidates = selection.pool.map((r) => ({
      resultId: r.id,
      url: r.url,
      classification: "main" as const,
      trusted: selection.trustedIds.has(r.id),
      contactLikeUrl: (r.url || "").includes("contatti"),
      emails: r.text.includes("info@example.com") ? ["info@example.com"] : [],
      phones: r.text.includes("111 2222") ? ["+393331112222"] : []
    }));

    const choice = selectBestGenericContactSource(candidates);
    expect(choice.selected?.resultId).toBe(mainContact.id);
    expect(choice.conflict).toBe(false);
  });
});
