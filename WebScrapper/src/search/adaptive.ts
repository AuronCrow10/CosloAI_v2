import type { SearchResult } from '../types.js';
import { estimateTokens } from './tokenEstimate.js';

export interface AdaptiveConfig {
  minLimit: number;
  maxLimit: number;
  contextTokenBudget: number;
  limitOverride?: number;
}

export interface AdaptiveDebug {
  adaptiveLimit: boolean;
  chosenFinalLimit: number;
  tokenBudget: number;
  estimatedTokensUsed: number;
  scoreSummary: {
    topScore: number;
    gap12: number;
    gap13: number;
  };
  queryComplexity: {
    wordCount: number;
    hasMultiPartSignal: boolean;
  };
}

const MULTI_PART_SIGNALS = [' and ', ' compare ', ' difference ', '?', ' vs '];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


function summarizeScores(results: SearchResult[]) {
  const topScore = results[0]?.score ?? 0;
  const score2 = results[1]?.score ?? 0;
  const score3 = results[2]?.score ?? 0;
  return {
    topScore,
    gap12: topScore - score2,
    gap13: topScore - score3,
  };
}

function analyzeQueryComplexity(query: string) {
  const normalized = ` ${query.toLowerCase()} `;
  const wordCount = normalized.trim().split(/\s+/).filter(Boolean).length;
  const hasMultiPartSignal = MULTI_PART_SIGNALS.some((s) => normalized.includes(s));
  return { wordCount, hasMultiPartSignal };
}

function decideTargetLimit(params: {
  scores: ReturnType<typeof summarizeScores>;
  complexity: ReturnType<typeof analyzeQueryComplexity>;
  config: AdaptiveConfig;
}): number {
  const { scores, complexity, config } = params;
  const { minLimit, maxLimit } = config;

  const simpleQuery = complexity.wordCount <= 5 && !complexity.hasMultiPartSignal;
  const highConfidence = scores.topScore >= 0.85 && scores.gap12 >= 0.1;
  const lowConfidence = scores.topScore < 0.55 || scores.gap13 < 0.05;

  if (highConfidence && simpleQuery) return clamp(2, minLimit, maxLimit);
  if (lowConfidence || complexity.hasMultiPartSignal || complexity.wordCount >= 10)
    return clamp(5, minLimit, maxLimit);
  return clamp(4, minLimit, maxLimit);
}

export function applyAdaptiveLimit(params: {
  query: string;
  results: SearchResult[];
  config: AdaptiveConfig;
}): { results: SearchResult[]; debug: AdaptiveDebug } {
  const { query, results, config } = params;

  const scores = summarizeScores(results);
  const complexity = analyzeQueryComplexity(query);
  const targetLimit = decideTargetLimit({ scores, complexity, config });
  const effectiveMax = config.limitOverride
    ? Math.min(config.limitOverride, config.maxLimit)
    : config.maxLimit;
  const finalLimit = clamp(targetLimit, config.minLimit, effectiveMax);

  let usedTokens = 0;
  const finalResults: SearchResult[] = [];

  for (const r of results) {
    if (finalResults.length >= finalLimit) break;
    const estimate = estimateTokens(r.text || '');
    if (
      usedTokens + estimate > config.contextTokenBudget &&
      finalResults.length >= config.minLimit
    ) {
      break;
    }
    usedTokens += estimate;
    finalResults.push(r);
  }

  return {
    results: finalResults,
    debug: {
      adaptiveLimit: true,
      chosenFinalLimit: finalResults.length,
      tokenBudget: config.contextTokenBudget,
      estimatedTokensUsed: usedTokens,
      scoreSummary: scores,
      queryComplexity: complexity,
    },
  };
}
