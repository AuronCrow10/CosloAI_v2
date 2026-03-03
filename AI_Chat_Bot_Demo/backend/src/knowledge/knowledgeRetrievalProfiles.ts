export const KNOWLEDGE_RETRIEVAL_PROFILES = [
  "balanced",
  "precise",
  "broad"
] as const;

export type KnowledgeRetrievalProfile =
  (typeof KNOWLEDGE_RETRIEVAL_PROFILES)[number];

export type KnowledgeSearchParams = {
  strategy?: "vector" | "hybrid";
  candidateLimit?: number;
  finalLimit?: number;
  ftsLanguage?:
    | "en"
    | "it"
    | "es"
    | "de"
    | "fr"
    | "english"
    | "italian"
    | "spanish"
    | "german"
    | "french"
    | "simple";
  includeAdjacent?: boolean;
  adjacentWindow?: number;
  stitchChunks?: boolean;
  dedupeResults?: boolean;
  diversifySources?: boolean;
  maxPerSource?: number;
  nearDuplicateThreshold?: number;
  adaptiveLimit?: boolean;
  minLimit?: number;
  maxLimit?: number;
  contextTokenBudget?: number;
  minConfidenceLevel?: "low" | "medium" | "high";
  noAnswerOnLowConfidence?: boolean;
  returnDebug?: boolean;
};

const PROFILE_PARAMS: Record<KnowledgeRetrievalProfile, KnowledgeSearchParams> = {
  balanced: {
    strategy: "hybrid",
    candidateLimit: 30,
    finalLimit: 10,
    includeAdjacent: true,
    adjacentWindow: 1,
    stitchChunks: true,
    dedupeResults: true,
    diversifySources: true,
    maxPerSource: 2,
    nearDuplicateThreshold: 0.85,
    adaptiveLimit: true,
    minLimit: 3,
    maxLimit: 5,
    contextTokenBudget: 1500,
    minConfidenceLevel: "medium",
    noAnswerOnLowConfidence: false,
    returnDebug: false
  },
  precise: {
    strategy: "hybrid",
    candidateLimit: 25,
    finalLimit: 8,
    includeAdjacent: true,
    adjacentWindow: 1,
    stitchChunks: true,
    dedupeResults: true,
    diversifySources: true,
    maxPerSource: 1,
    nearDuplicateThreshold: 0.85,
    adaptiveLimit: true,
    minLimit: 2,
    maxLimit: 4,
    contextTokenBudget: 1000,
    minConfidenceLevel: "medium",
    noAnswerOnLowConfidence: false,
    returnDebug: false
  },
  broad: {
    strategy: "hybrid",
    candidateLimit: 40,
    finalLimit: 12,
    includeAdjacent: true,
    adjacentWindow: 1,
    stitchChunks: true,
    dedupeResults: true,
    diversifySources: true,
    maxPerSource: 2,
    nearDuplicateThreshold: 0.9,
    adaptiveLimit: true,
    minLimit: 4,
    maxLimit: 6,
    contextTokenBudget: 1800,
    minConfidenceLevel: "medium",
    noAnswerOnLowConfidence: false,
    returnDebug: false
  }
};

export function resolveKnowledgeRetrievalProfile(
  input: unknown
): KnowledgeRetrievalProfile {
  if (typeof input !== "string") return "balanced";
  const normalized = input.trim().toLowerCase();
  if (
    normalized === "balanced" ||
    normalized === "precise" ||
    normalized === "broad"
  ) {
    return normalized;
  }
  return "balanced";
}

export function getKnowledgeRetrievalParams(
  profile: unknown
): KnowledgeSearchParams {
  const resolved = resolveKnowledgeRetrievalProfile(profile);
  return { ...PROFILE_PARAMS[resolved] };
}
