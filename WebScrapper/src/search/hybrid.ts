import type { SearchResult } from '../types.js';
import { DEFAULT_RRF_K } from './qualityConfig.js';

export type SearchStrategy = 'vector' | 'hybrid';

export interface HybridScoreBreakdown {
  id: string;
  vectorRank: number | null;
  keywordRank: number | null;
  rrfScore: number;
  normalizedScore: number;
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
  const maxPossibleRrf = 2 / (rrfK + 1);
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
    const normalizedScore = Math.max(
      0,
      Math.min(1, maxPossibleRrf > 0 ? rrfScore / maxPossibleRrf : 0),
    );

    scored.push({ candidate: c, rrfScore });
    breakdown.push({
      id: c.id,
      vectorRank: vRank,
      keywordRank: kRank,
      rrfScore,
      normalizedScore,
    });
  }

  breakdown.sort((a, b) => b.normalizedScore - a.normalizedScore);

  const scoreById = new Map<string, number>();
  for (const row of breakdown) {
    scoreById.set(row.id, row.normalizedScore);
  }

  scored.sort((a, b) => {
    const aScore = scoreById.get(a.candidate.id) ?? 0;
    const bScore = scoreById.get(b.candidate.id) ?? 0;
    return bScore - aScore;
  });

  const results = scored.slice(0, params.finalLimit).map(({ candidate }) => ({
    id: candidate.id,
    clientId: candidate.clientId,
    domain: candidate.domain,
    url: candidate.url,
    sourceId: candidate.sourceId ?? null,
    chunkIndex: candidate.chunkIndex,
    text: candidate.text,
    createdAt: candidate.createdAt,
    score: scoreById.get(candidate.id) ?? 0,
  }));

  return { results, breakdown: breakdown.slice(0, params.finalLimit) };
}
