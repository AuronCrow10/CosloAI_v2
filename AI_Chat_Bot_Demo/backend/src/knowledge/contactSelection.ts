import type { KnowledgeSearchResult } from "./client";
import {
  classifyContactSource,
  scoreContactSourceReliability
} from "./contactSourceClassification";

export function isTrustedGenericContactSource(result: KnowledgeSearchResult): boolean {
  const kind = classifyContactSource({
    url: result.url,
    text: result.text,
    preferPartnerSources: false
  });
  if (kind === "partner") return false;
  const score = scoreContactSourceReliability({
    url: result.url,
    text: result.text,
    classification: kind
  });
  return score >= 4;
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
  const scoredById = new Map<string, number>();

  for (const r of results) {
    const kind = classifyContactSource({
      url: r.url,
      text: r.text,
      preferPartnerSources
    });
    buckets[kind].push(r);
    const score = scoreContactSourceReliability({
      url: r.url,
      text: r.text,
      classification: kind
    });
    scoredById.set(r.id, score);
  }

  const withScore = (items: KnowledgeSearchResult[]) =>
    items
      .map((item) => ({
        item,
        score: scoredById.get(item.id) ?? 0
      }))
      .sort((a, b) => b.score - a.score);

  const idsFrom = (items: KnowledgeSearchResult[]) => new Set(items.map((r) => r.id));

  const hasMain = buckets.main.length > 0;
  if (preferPartnerSources) {
    const rankedPartners = withScore(buckets.partner);
    const rankedMain = withScore(buckets.main);
    const rankedUnknown = withScore(buckets.unknown);
    const strongPartners = rankedPartners.filter((entry) => entry.score >= 2).map((entry) => entry.item);
    const fallbackPool =
      strongPartners.length > 0
        ? strongPartners
        : rankedPartners.length > 0
        ? rankedPartners.map((entry) => entry.item)
        : rankedMain.length > 0
        ? rankedMain.filter((entry) => entry.score >= 2).map((entry) => entry.item)
        : rankedUnknown.filter((entry) => entry.score >= 4).map((entry) => entry.item);

    return {
      pool: fallbackPool,
      buckets,
      trustedUnknownCount: 0,
      rejectedUnknownCount: Math.max(0, buckets.unknown.length - fallbackPool.length),
      trustedIds: idsFrom(fallbackPool)
    };
  }

  if (hasMain) {
    const rankedMain = withScore(buckets.main);
    const trustedMain = rankedMain.filter((entry) => entry.score >= 2).map((entry) => entry.item);
    const pool = trustedMain.length > 0 ? trustedMain : rankedMain.map((entry) => entry.item);
    return {
      pool,
      buckets,
      trustedUnknownCount: 0,
      rejectedUnknownCount: buckets.unknown.length,
      trustedIds: idsFrom(pool)
    };
  }

  const rankedUnknown = withScore(buckets.unknown);
  const trustedUnknown = rankedUnknown
    .filter((entry) => entry.score >= 4 && isTrustedGenericContactSource(entry.item))
    .map((entry) => entry.item);
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
  sourceText?: string | null;
  classification: "main" | "partner" | "unknown";
  trusted: boolean;
  contactLikeUrl: boolean;
  emails: string[];
  phones: string[];
};

type AggregatedContactSource = {
  sourceKey: string;
  representative: ContactCandidate;
  authorityScore: number;
  emails: string[];
  phones: string[];
  emailKey: string;
  phoneKey: string;
};

const AUTHORITY_MIN_SCORE = 4;
const AUTHORITY_CLEAR_MARGIN = 2;
const ADDRESS_HINT_TOKENS = [
  "address",
  "indirizzo",
  "sede",
  "headquarter",
  "headquarters",
  "via ",
  "piazza",
  "street",
  "road",
  "city",
  "zip",
  "postcode",
  "cap "
];
const BUSINESS_IDENTITY_TOKENS = [
  "azienda",
  "company",
  "societa",
  "impresa",
  "business",
  "impressum",
  "partita iva",
  "vat",
  "legal name"
];
const LOW_TRUST_HINT_TOKENS = [
  "privacy",
  "cookie",
  "terms",
  "condition",
  "blog",
  "news",
  "article",
  "product",
  "catalog",
  "category",
  "cart",
  "checkout"
];

function normalizeEmailForCompare(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function normalizePhoneForCompare(value: string): string {
  const compact = String(value || "").replace(/[^\d+]/g, "");
  if (compact.startsWith("00") && compact.length > 4) return `+${compact.slice(2)}`;
  return compact;
}

function normalizedSet(values: string[], normalizer: (value: string) => string): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizer(value))
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function overlapCount(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let count = 0;
  for (const value of b) {
    if (setA.has(value)) count += 1;
  }
  return count;
}

function hasAnyToken(value: string, tokens: string[]): boolean {
  if (!value) return false;
  const folded = value.toLowerCase();
  return tokens.some((token) => folded.includes(token));
}

function computeContactAuthorityScore(candidate: ContactCandidate): number {
  const sourceText = String(candidate.sourceText || "");
  const sourceUrl = String(candidate.url || "");
  let score = scoreContactSourceReliability({
    url: sourceUrl,
    text: sourceText,
    classification: candidate.classification
  });
  if (candidate.contactLikeUrl) score += 2;
  if (candidate.classification === "partner") score -= 4;

  if (candidate.emails.length > 0) score += 4;
  if (candidate.phones.length > 0) score += 4;
  if (candidate.emails.length > 0 && candidate.phones.length > 0) score += 5;

  if (hasAnyToken(sourceText, ADDRESS_HINT_TOKENS) || hasAnyToken(sourceUrl, ADDRESS_HINT_TOKENS)) {
    score += 2;
  }
  if (
    hasAnyToken(sourceText, BUSINESS_IDENTITY_TOKENS) ||
    hasAnyToken(sourceUrl, BUSINESS_IDENTITY_TOKENS)
  ) {
    score += 2;
  }
  if (hasAnyToken(sourceText, LOW_TRUST_HINT_TOKENS) || hasAnyToken(sourceUrl, LOW_TRUST_HINT_TOKENS)) {
    score -= 4;
  }
  if (candidate.trusted) score += 1;
  return score;
}

function aggregateCandidates(candidates: ContactCandidate[]): AggregatedContactSource[] {
  const bySource = new Map<string, ContactCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.trusted) continue;
    const sourceKey =
      String(candidate.resultId || "").trim() ||
      String(candidate.url || "").trim().toLowerCase();
    if (!sourceKey) continue;
    if (!bySource.has(sourceKey)) bySource.set(sourceKey, []);
    bySource.get(sourceKey)!.push(candidate);
  }

  const aggregated: AggregatedContactSource[] = [];
  for (const [sourceKey, list] of bySource.entries()) {
    const emails = normalizedSet(
      list.flatMap((item) => item.emails || []),
      normalizeEmailForCompare
    );
    const phones = normalizedSet(
      list.flatMap((item) => item.phones || []),
      normalizePhoneForCompare
    );
    const representative: ContactCandidate = {
      ...list[0],
      trusted: list.some((item) => item.trusted),
      contactLikeUrl: list.some((item) => item.contactLikeUrl),
      emails,
      phones,
      sourceText:
        list
          .map((item) => String(item.sourceText || "").trim())
          .find((value) => value.length > 0) ?? list[0].sourceText
    };
    const authorityScore =
      Math.max(...list.map((item) => computeContactAuthorityScore(item))) +
      Math.min(2, emails.length + phones.length);
    aggregated.push({
      sourceKey,
      representative,
      authorityScore,
      emails,
      phones,
      emailKey: emails.join(","),
      phoneKey: phones.join(",")
    });
  }

  return aggregated.sort((a, b) => b.authorityScore - a.authorityScore);
}

function haveEquivalentContacts(a: AggregatedContactSource, b: AggregatedContactSource): boolean {
  const emailOverlap = overlapCount(a.emails, b.emails);
  const phoneOverlap = overlapCount(a.phones, b.phones);
  const emailEquivalent =
    (a.emails.length === 0 && b.emails.length === 0) ||
    (emailOverlap > 0 && emailOverlap === Math.min(a.emails.length, b.emails.length));
  const phoneEquivalent =
    (a.phones.length === 0 && b.phones.length === 0) ||
    (phoneOverlap > 0 && phoneOverlap === Math.min(a.phones.length, b.phones.length));
  return emailEquivalent && phoneEquivalent;
}

function haveAnyContactOverlap(a: AggregatedContactSource, b: AggregatedContactSource): boolean {
  return overlapCount(a.emails, b.emails) > 0 || overlapCount(a.phones, b.phones) > 0;
}

export function selectBestGenericContactSource(
  candidates: ContactCandidate[]
): { selected: ContactCandidate | null; conflict: boolean } {
  if (candidates.length === 0) return { selected: null, conflict: false };
  const aggregated = aggregateCandidates(candidates);
  const top = aggregated[0];
  if (!top) return { selected: null, conflict: false };
  if (top.authorityScore < AUTHORITY_MIN_SCORE) {
    return { selected: null, conflict: false };
  }

  const runnerUp = aggregated[1];
  if (!runnerUp) {
    return { selected: top.representative, conflict: false };
  }
  if (runnerUp.authorityScore < AUTHORITY_MIN_SCORE) {
    return { selected: top.representative, conflict: false };
  }

  const margin = top.authorityScore - runnerUp.authorityScore;
  if (margin >= AUTHORITY_CLEAR_MARGIN) {
    return { selected: top.representative, conflict: false };
  }

  if (haveEquivalentContacts(top, runnerUp) || haveAnyContactOverlap(top, runnerUp)) {
    return { selected: top.representative, conflict: false };
  }

  const topHasContactData = top.emailKey.length > 0 || top.phoneKey.length > 0;
  const runnerHasContactData = runnerUp.emailKey.length > 0 || runnerUp.phoneKey.length > 0;
  if (!topHasContactData || !runnerHasContactData) {
    return { selected: top.representative, conflict: false };
  }

  const topHasBoth = top.emails.length > 0 && top.phones.length > 0;
  const runnerHasBoth = runnerUp.emails.length > 0 && runnerUp.phones.length > 0;
  if (topHasBoth && !runnerHasBoth) {
    return { selected: top.representative, conflict: false };
  }

  return { selected: null, conflict: true };
}
