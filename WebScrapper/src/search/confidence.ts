import type { SearchResult } from '../types.js';
import { DEFAULT_CONFIDENCE_CONFIG } from './qualityConfig.js';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type ConfidenceReason =
  | 'NO_RESULTS'
  | 'LOW_TOP_SCORE'
  | 'FLAT_SCORE_DISTRIBUTION'
  | 'TOO_FEW_RESULTS'
  | 'NO_KEYWORD_MATCH';

export interface ConfidenceSignals {
  topScore: number;
  gap12: number;
  gap13: number;
  strongCount: number;
  resultCount: number;
  keywordPresent: boolean | null;
}

export interface ConfidenceConfig {
  strongScoreThreshold: number;
  highTopScore: number;
  mediumTopScore: number;
  minGapHigh: number;
  minGapMedium: number;
  minStrongHigh: number;
  minStrongMedium: number;
}

export interface ConfidenceSummary {
  score: number;
  level: ConfidenceLevel;
  reasons: ConfidenceReason[];
  signals?: ConfidenceSignals;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function computeConfidence(params: {
  results: SearchResult[];
  config?: ConfidenceConfig;
  keywordPresent?: boolean | null;
  includeSignals?: boolean;
}): ConfidenceSummary {
  const { results, keywordPresent = null } = params;
  const config = params.config ?? DEFAULT_CONFIDENCE_CONFIG;

  const resultCount = results.length;
  if (resultCount === 0) {
    return {
      score: 0,
      level: 'low',
      reasons: ['NO_RESULTS', 'TOO_FEW_RESULTS'],
      signals: params.includeSignals
        ? {
            topScore: 0,
            gap12: 0,
            gap13: 0,
            strongCount: 0,
            resultCount,
            keywordPresent,
          }
        : undefined,
    };
  }

  const topScore = results[0]?.score ?? 0;
  const score2 = results[1]?.score ?? 0;
  const score3 = results[2]?.score ?? 0;
  const gap12 = topScore - score2;
  const gap13 = topScore - score3;
  const strongCount = results.filter((r) => r.score >= config.strongScoreThreshold).length;

  const reasons: ConfidenceReason[] = [];
  if (topScore < config.mediumTopScore) reasons.push('LOW_TOP_SCORE');
  if (gap13 < config.minGapMedium) reasons.push('FLAT_SCORE_DISTRIBUTION');
  if (resultCount < 2) reasons.push('TOO_FEW_RESULTS');
  if (keywordPresent === false) reasons.push('NO_KEYWORD_MATCH');

  let level: ConfidenceLevel = 'low';
  if (
    topScore >= config.highTopScore &&
    gap12 >= config.minGapHigh &&
    strongCount >= config.minStrongHigh
  ) {
    level = 'high';
  } else if (
    topScore >= config.mediumTopScore &&
    gap12 >= config.minGapMedium &&
    strongCount >= config.minStrongMedium
  ) {
    level = 'medium';
  }

  const score =
    0.5 * clamp(topScore) +
    0.3 * clamp(gap12) +
    0.2 * clamp(strongCount / Math.max(1, resultCount));

  return {
    score: clamp(score),
    level,
    reasons,
    signals: params.includeSignals
      ? {
          topScore,
          gap12,
          gap13,
          strongCount,
          resultCount,
          keywordPresent,
        }
      : undefined,
  };
}
