export const DEFAULT_RRF_K = 60;

export const DEFAULT_ADAPTIVE_CONFIG = {
  minLimit: 3,
  maxLimit: 6,
  contextTokenBudget: 1500,
};

export const DEFAULT_CONFIDENCE_CONFIG = {
  strongScoreThreshold: 0.75,
  highTopScore: 0.85,
  mediumTopScore: 0.65,
  minGapHigh: 0.08,
  minGapMedium: 0.03,
  minStrongHigh: 2,
  minStrongMedium: 1,
};

export const DEFAULT_MAX_PER_SOURCE = 2;
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.85;

export const NO_LLM_QUALITY_PRESET = {
  strategy: 'hybrid' as const,
  includeAdjacent: true,
  adjacentWindow: 1,
  stitchChunks: true,
  dedupeResults: true,
  diversifySources: true,
  maxPerSource: 2,
  adaptiveLimit: true,
  minLimit: 3,
  maxLimit: 5,
  contextTokenBudget: 1500,
  returnDebug: false,
};
