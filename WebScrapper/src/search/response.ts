import type { SearchResponse } from './service.js';

export interface SearchHttpResponse {
  results: SearchResponse['results'];
  retrievalStatus: 'ok' | 'low_confidence';
  noAnswerRecommended: boolean;
  confidence: { level: 'high' | 'medium' | 'low'; score: number };
  debug?: SearchResponse['debug'];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function buildSearchHttpResponse(params: {
  serviceResponse: SearchResponse;
  returnDebug: boolean;
}): SearchHttpResponse {
  const { serviceResponse, returnDebug } = params;
  const confidenceLevel = serviceResponse.confidence?.level ?? 'low';
  const confidenceScore = clampScore(serviceResponse.confidence?.score ?? 0);

  return {
    results: serviceResponse.results ?? [],
    retrievalStatus: serviceResponse.retrievalStatus ?? 'ok',
    noAnswerRecommended: serviceResponse.noAnswerRecommended ?? false,
    confidence: {
      level: confidenceLevel,
      score: confidenceScore,
    },
    ...(returnDebug ? { debug: serviceResponse.debug } : {}),
  };
}
