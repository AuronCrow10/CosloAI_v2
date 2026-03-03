import type { SearchResult } from '../types.js';
import { DEFAULT_RRF_K } from './qualityConfig.js';

export type SearchStrategy = 'vector' | 'hybrid';

export interface HybridScoreBreakdown {
  id: string;
  vectorRank: number | null;
  keywordRank: number | null;
  rrfScore: number;
}

type Candidate = {
  id: string;
  clientId: string;
  domain: string;
  url: string;
  sourceId?: string | null;
  chunkIndex: number;
  text: string;
  createdAt: Date;
};

export function finalizeVectorResults(
  results: SearchResult[],
  limit: number,
): SearchResult[] {
  return results.slice(0, limit);
}

export function buildHybridResults(params: {
  vectorCandidates: SearchResult[];
  keywordCandidates: SearchResult[];
  finalLimit: number;
  rrfK?: number;
}): { results: SearchResult[]; breakdown: HybridScoreBreakdown[] } {
  const rrfK = params.rrfK ?? DEFAULT_RRF_K;
  const merged = new Map<string, Candidate>();

  const vectorRanks = new Map<string, number>();
  params.vectorCandidates.forEach((v, idx) => {
    vectorRanks.set(v.id, idx + 1);
    merged.set(v.id, {
      id: v.id,
      clientId: v.clientId,
      domain: v.domain,
      url: v.url,
      sourceId: v.sourceId ?? null,
      chunkIndex: v.chunkIndex,
      text: v.text,
      createdAt: v.createdAt,
    });
  });

  const keywordRanks = new Map<string, number>();
  params.keywordCandidates.forEach((k, idx) => {
    keywordRanks.set(k.id, idx + 1);
    if (!merged.has(k.id)) {
      merged.set(k.id, {
        id: k.id,
        clientId: k.clientId,
        domain: k.domain,
        url: k.url,
        sourceId: k.sourceId ?? null,
        chunkIndex: k.chunkIndex,
        text: k.text,
        createdAt: k.createdAt,
      });
    }
  });

  const scored: Array<{ candidate: Candidate; rrfScore: number }> = [];
  const breakdown: HybridScoreBreakdown[] = [];

  for (const c of merged.values()) {
    const vRank = vectorRanks.get(c.id) ?? null;
    const kRank = keywordRanks.get(c.id) ?? null;
    const vScore = vRank ? 1 / (rrfK + vRank) : 0;
    const kScore = kRank ? 1 / (rrfK + kRank) : 0;
    const rrfScore = vScore + kScore;

    scored.push({ candidate: c, rrfScore });
    breakdown.push({
      id: c.id,
      vectorRank: vRank,
      keywordRank: kRank,
      rrfScore,
    });
  }

  scored.sort((a, b) => b.rrfScore - a.rrfScore);
  breakdown.sort((a, b) => b.rrfScore - a.rrfScore);

  const results = scored.slice(0, params.finalLimit).map(({ candidate, rrfScore }) => ({
    id: candidate.id,
    clientId: candidate.clientId,
    domain: candidate.domain,
    url: candidate.url,
    sourceId: candidate.sourceId ?? null,
    chunkIndex: candidate.chunkIndex,
    text: candidate.text,
    createdAt: candidate.createdAt,
    score: rrfScore,
  }));

  return { results, breakdown: breakdown.slice(0, params.finalLimit) };
}
