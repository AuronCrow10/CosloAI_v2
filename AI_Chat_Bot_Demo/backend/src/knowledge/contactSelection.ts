import type { KnowledgeSearchResult } from "./client";
import { classifyContactSource } from "./contactSourceClassification";

const CONTACT_URL_TOKENS = ["contact", "contatti", "contatto", "contattaci", "contacto"];
const PARTNER_TOKENS = ["partner", "partners", "collaborazioni", "colaboraciones"];

export function isTrustedGenericContactSource(result: KnowledgeSearchResult): boolean {
  const url = (result.url || "").toLowerCase();
  const text = (result.text || "").toLowerCase();
  const hasContact = CONTACT_URL_TOKENS.some((t) => url.includes(t) || text.includes(t));
  const hasPartner = PARTNER_TOKENS.some((t) => url.includes(t) || text.includes(t));
  return hasContact && !hasPartner;
}

export function selectContactExtractionPool(params: {
  results: KnowledgeSearchResult[];
  preferPartnerSources: boolean;
}) {
  const { results, preferPartnerSources } = params;
  const buckets = {
    main: [] as KnowledgeSearchResult[],
    partner: [] as KnowledgeSearchResult[],
    unknown: [] as KnowledgeSearchResult[]
  };

  for (const r of results) {
    const kind = classifyContactSource({
      url: r.url,
      text: r.text,
      preferPartnerSources
    });
    buckets[kind].push(r);
  }

  const hasMain = buckets.main.length > 0;
  if (preferPartnerSources) {
    return {
      pool:
        buckets.partner.length > 0
          ? buckets.partner
          : buckets.main.length > 0
          ? buckets.main
          : buckets.unknown,
      buckets,
      trustedUnknownCount: 0,
      rejectedUnknownCount: 0,
      trustedIds: new Set(
        (buckets.partner.length > 0
          ? buckets.partner
          : buckets.main.length > 0
          ? buckets.main
          : buckets.unknown
        ).map((r) => r.id)
      )
    };
  }

  if (hasMain) {
    return {
      pool: buckets.main,
      buckets,
      trustedUnknownCount: 0,
      rejectedUnknownCount: buckets.unknown.length,
      trustedIds: new Set(buckets.main.map((r) => r.id))
    };
  }

  const trustedUnknown = buckets.unknown.filter(isTrustedGenericContactSource);
  return {
    pool: trustedUnknown,
    buckets,
    trustedUnknownCount: trustedUnknown.length,
    rejectedUnknownCount: buckets.unknown.length - trustedUnknown.length,
    trustedIds: new Set(trustedUnknown.map((r) => r.id))
  };
}

export type ContactCandidate = {
  resultId?: string | null;
  url?: string | null;
  classification: "main" | "partner" | "unknown";
  trusted: boolean;
  contactLikeUrl: boolean;
  emails: string[];
  phones: string[];
};

function countContacts(candidate: ContactCandidate): number {
  return candidate.emails.length + candidate.phones.length;
}

export function selectBestGenericContactSource(
  candidates: ContactCandidate[]
): { selected: ContactCandidate | null; conflict: boolean } {
  if (candidates.length === 0) return { selected: null, conflict: false };

  const scored = candidates
    .filter((c) => c.trusted)
    .map((c) => {
      let score = 0;
      if (c.contactLikeUrl) score += 3;
      if (c.classification === "main") score += 2;
      if (c.classification === "unknown") score -= 1;
      if (c.classification === "partner") score -= 5;
      if (c.emails.length > 0) score += 1;
      if (c.phones.length > 0) score += 1;
      const total = countContacts(c);
      if (total > 2) score -= Math.min(3, total - 2);
      return { candidate: c, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return { selected: null, conflict: false };
  const runnerUp = scored[1];
  if (runnerUp && Math.abs(top.score - runnerUp.score) <= 1) {
    const topKey = `${top.candidate.emails.join(",")}|${top.candidate.phones.join(",")}`;
    const runnerKey = `${runnerUp.candidate.emails.join(",")}|${runnerUp.candidate.phones.join(",")}`;
    if (topKey && runnerKey && topKey !== runnerKey) {
      return { selected: null, conflict: true };
    }
  }

  return { selected: top.candidate, conflict: false };
}
