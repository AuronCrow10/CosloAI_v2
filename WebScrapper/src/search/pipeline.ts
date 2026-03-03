import type { SearchResult } from '../types.js';
import {
  applyDedupeAndDiversity,
  type DedupeDebug,
} from './selection.js';
import {
  applyAdaptiveLimit,
  type AdaptiveDebug,
} from './adaptive.js';
import {
  computeConfidence,
  type ConfidenceLevel,
  type ConfidenceSummary,
} from './confidence.js';
import { DEFAULT_ADAPTIVE_CONFIG, DEFAULT_CONFIDENCE_CONFIG } from './qualityConfig.js';

export interface QualityPipelineOptions {
  dedupeResults?: boolean;
  diversifySources?: boolean;
  maxPerSource?: number;
  nearDuplicateThreshold?: number;
  adaptiveLimit?: boolean;
  minLimit?: number;
  maxLimit?: number;
  contextTokenBudget?: number;
  limitOverride?: number;
  minConfidenceLevel?: ConfidenceLevel;
  noAnswerOnLowConfidence?: boolean;
  finalLimit: number;
  returnDebug?: boolean;
}

export interface QualityPipelineDebug {
  selection?: DedupeDebug;
  adaptive?: AdaptiveDebug;
  confidence?: ConfidenceSummary;
}

export interface QualityPipelineResult {
  results: SearchResult[];
  retrievalStatus: 'ok' | 'low_confidence';
  noAnswerRecommended: boolean;
  confidence: ConfidenceSummary;
  debug?: QualityPipelineDebug;
}

export function runQualityPipeline(params: {
  query: string;
  results: SearchResult[];
  keywordPresent: boolean | null;
  options: QualityPipelineOptions;
}): QualityPipelineResult {
  const { query, results, keywordPresent, options } = params;

  let final = applyDedupeAndDiversity({
    results,
    options: {
      dedupeResults: options.dedupeResults ?? false,
      diversifySources: options.diversifySources ?? false,
      maxPerSource: options.maxPerSource,
      nearDuplicateThreshold: options.nearDuplicateThreshold,
      finalLimit: options.finalLimit,
    },
  });

  let debug: QualityPipelineDebug | undefined = options.returnDebug
    ? { selection: final.debug }
    : undefined;

  if (options.adaptiveLimit) {
    const adaptive = applyAdaptiveLimit({
      query,
      results: final.results,
      config: {
        minLimit: options.minLimit ?? DEFAULT_ADAPTIVE_CONFIG.minLimit,
        maxLimit: options.maxLimit ?? DEFAULT_ADAPTIVE_CONFIG.maxLimit,
        contextTokenBudget:
          options.contextTokenBudget ?? DEFAULT_ADAPTIVE_CONFIG.contextTokenBudget,
        limitOverride: options.limitOverride,
      },
    });
    final = { results: adaptive.results, debug: final.debug };
    if (debug) {
      debug.adaptive = adaptive.debug;
    }
  }

  const confidence = computeConfidence({
    results: final.results,
    config: DEFAULT_CONFIDENCE_CONFIG,
    keywordPresent,
    includeSignals: options.returnDebug,
  });

  if (debug) {
    debug.confidence = confidence;
  }

  const threshold = options.minConfidenceLevel ?? 'low';
  const belowThreshold =
    (threshold === 'high' && confidence.level !== 'high') ||
    (threshold === 'medium' && confidence.level === 'low');
  const noAnswer =
    options.noAnswerOnLowConfidence === true && belowThreshold;

  return {
    results: noAnswer ? [] : final.results,
    retrievalStatus: belowThreshold ? 'low_confidence' : 'ok',
    noAnswerRecommended: belowThreshold,
    confidence,
    debug,
  };
}
