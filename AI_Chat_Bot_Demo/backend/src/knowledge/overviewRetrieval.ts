import {
  KnowledgeSearchResponse,
  KnowledgeSearchResult,
  SearchKnowledgeParams,
  searchKnowledgeWithMeta
} from "./client";
import { getOverviewCoverageQueries } from "./overviewCoverageQueries";

export type OverviewRetrievalDebug = {
  mode: "overview";
  queriesAttempted: number;
  queriesSucceeded: number;
  mergedCount: number;
};

export type OverviewRetrievalResult = KnowledgeSearchResponse & {
  debug?: OverviewRetrievalDebug;
};

type OverviewRetrievalParams = {
  clientId: string;
  domain?: string;
  ftsLanguage?: "en" | "it" | "es" | "de" | "fr";
  retrievalParams: Omit<SearchKnowledgeParams, "clientId" | "query" | "domain">;
  maxResults?: number;
  maxPerSource?: number;
};

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_PER_SOURCE = 2;

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

function mergeAndDedupeResults(params: {
  allResults: KnowledgeSearchResult[];
  maxResults: number;
  maxPerSource: number;
}): KnowledgeSearchResult[] {
  const { allResults, maxResults, maxPerSource } = params;
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

  const unique = Array.from(seen.values()).sort((a, b) => b.score - a.score);
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

export async function searchKnowledgeOverview(
  params: OverviewRetrievalParams
): Promise<OverviewRetrievalResult> {
  const {
    clientId,
    domain,
    ftsLanguage,
    retrievalParams,
    maxResults = DEFAULT_MAX_RESULTS,
    maxPerSource = DEFAULT_MAX_PER_SOURCE
  } = params;

  const queries = getOverviewCoverageQueries(ftsLanguage);

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
  const merged = mergeAndDedupeResults({
    allResults,
    maxResults,
    maxPerSource
  });

  const meta = aggregateMeta(successes);

  return {
    results: merged,
    ...meta,
    debug: {
      mode: "overview",
      queriesAttempted: queries.length,
      queriesSucceeded: successes.length,
      mergedCount: merged.length
    }
  };
}

export const __testing__ = {
  aggregateMeta,
  mergeAndDedupeResults
};
