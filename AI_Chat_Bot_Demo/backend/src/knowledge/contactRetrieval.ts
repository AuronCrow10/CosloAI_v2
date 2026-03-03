import {
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  SearchKnowledgeParams,
  searchKnowledgeWithMeta
} from "./client";
import { getContactHelperQueries } from "./contactHelperQueries";

export type ContactRetrievalDebug = {
  mode: "contact";
  queriesAttempted: number;
  queriesSucceeded: number;
  mergedCount: number;
  rawMerged: boolean;
};

export type ContactRetrievalResult = KnowledgeSearchResponse & {
  debug?: ContactRetrievalDebug;
};

type ContactRetrievalParams = {
  clientId: string;
  domain?: string;
  ftsLanguage?: "en" | "it" | "es" | "de" | "fr";
  retrievalParams: Omit<SearchKnowledgeParams, "clientId" | "query" | "domain">;
  rawQuery?: string;
  includeRawQuery?: boolean;
  maxResults?: number;
  maxPerSource?: number;
  preferPartnerSources?: boolean;
};

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_PER_SOURCE = 2;

const CONTACT_URL_TOKENS = ["contact", "contatti", "contatto", "contattaci", "contacto"];
const PARTNER_URL_TOKENS = ["partner", "partners", "collaborazioni", "colaboraciones"];

function urlScore(url: string, preferPartnerSources: boolean): number {
  const lower = url.toLowerCase();
  const hasContact = CONTACT_URL_TOKENS.some((t) => lower.includes(t));
  const hasPartner = PARTNER_URL_TOKENS.some((t) => lower.includes(t));

  if (preferPartnerSources) {
    if (hasPartner) return 3;
    if (hasContact) return 2;
  } else {
    if (hasContact && !hasPartner) return 3;
    if (hasPartner) return 0;
  }
  return hasContact ? 2 : 1;
}

function aggregateMeta(
  responses: KnowledgeSearchResponse[]
): Pick<
  KnowledgeSearchResponse,
  "retrievalStatus" | "noAnswerRecommended" | "confidence"
> {
  if (responses.length === 0) {
    return {
      retrievalStatus: "low_confidence",
      noAnswerRecommended: true,
      confidence: { level: "low", score: 0 }
    };
  }

  const hasOk = responses.some((r) => r.retrievalStatus === "ok");
  const noAnswerRecommended = responses.every((r) => r.noAnswerRecommended === true);
  const levels = responses
    .map((r) => r.confidence?.level)
    .filter(Boolean) as Array<"high" | "medium" | "low">;
  const levelOrder: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  const bestLevel = levels.sort(
    (a, b) => levelOrder.indexOf(a) - levelOrder.indexOf(b)
  )[0];
  const bestScore = responses.reduce((acc, r) => {
    const score = r.confidence?.score;
    if (typeof score === "number" && score > acc) return score;
    return acc;
  }, 0);

  return {
    retrievalStatus: hasOk ? "ok" : "low_confidence",
    noAnswerRecommended,
    confidence: bestLevel ? { level: bestLevel, score: bestScore } : { score: bestScore }
  };
}

function mergeAndRankResults(params: {
  allResults: KnowledgeSearchResult[];
  maxResults: number;
  maxPerSource: number;
  preferPartnerSources: boolean;
}): KnowledgeSearchResult[] {
  const { allResults, maxResults, maxPerSource, preferPartnerSources } = params;
  const seen = new Map<string, KnowledgeSearchResult>();

  for (const result of allResults) {
    const key =
      result.id ||
      `${result.url || "unknown"}#${String(result.chunkIndex ?? "0")}`;
    const existing = seen.get(key);
    if (!existing || result.score > existing.score) {
      seen.set(key, result);
    }
  }

  const unique = Array.from(seen.values());
  unique.sort((a, b) => {
    const aBoost = a.url ? urlScore(a.url, preferPartnerSources) : 0;
    const bBoost = b.url ? urlScore(b.url, preferPartnerSources) : 0;
    if (aBoost !== bBoost) return bBoost - aBoost;
    return b.score - a.score;
  });

  const perSourceCounts = new Map<string, number>();
  const selected: KnowledgeSearchResult[] = [];

  for (const result of unique) {
    const sourceKey = result.url || "unknown";
    const current = perSourceCounts.get(sourceKey) || 0;
    if (current >= maxPerSource) continue;
    selected.push(result);
    perSourceCounts.set(sourceKey, current + 1);
    if (selected.length >= maxResults) break;
  }

  return selected;
}

export async function searchKnowledgeContacts(
  params: ContactRetrievalParams
): Promise<ContactRetrievalResult> {
  const {
    clientId,
    domain,
    ftsLanguage,
    retrievalParams,
    rawQuery,
    includeRawQuery = true,
    maxResults = DEFAULT_MAX_RESULTS,
    maxPerSource = DEFAULT_MAX_PER_SOURCE,
    preferPartnerSources = false
  } = params;

  const helperQueries = getContactHelperQueries(ftsLanguage);
  const queries = includeRawQuery && rawQuery ? [...helperQueries, rawQuery] : helperQueries;

  const settled = await Promise.allSettled(
    queries.map((query) =>
      searchKnowledgeWithMeta({
        clientId,
        domain,
        query,
        ...retrievalParams,
        ftsLanguage
      })
    )
  );

  const successes: KnowledgeSearchResponse[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      successes.push(result.value);
    }
  }

  const allResults = successes.flatMap((res) => res.results || []);
  const merged = mergeAndRankResults({
    allResults,
    maxResults,
    maxPerSource,
    preferPartnerSources
  });

  const meta = aggregateMeta(successes);

  return {
    results: merged,
    ...meta,
    debug: {
      mode: "contact",
      queriesAttempted: queries.length,
      queriesSucceeded: successes.length,
      mergedCount: merged.length,
      rawMerged: includeRawQuery && Boolean(rawQuery)
    }
  };
}

export const __testing__ = {
  mergeAndRankResults,
  urlScore
};
