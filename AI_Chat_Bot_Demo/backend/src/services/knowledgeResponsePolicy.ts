import type { KnowledgeIntent } from "./knowledgeIntentClassifier";

export type KnowledgePolicyMode = "specific" | "overview" | "ambiguous";
export type KnowledgeResponseStrategy =
  | "answer"
  | "overview_summary"
  | "clarify"
  | "insufficient_info";

export interface KnowledgeRetrievalMeta {
  retrievalStatus?: "ok" | "low_confidence";
  noAnswerRecommended?: boolean;
  confidence?: { level?: "high" | "medium" | "low"; score?: number };
}

export interface KnowledgePolicyDecision {
  mode: KnowledgePolicyMode;
  responseStrategy: KnowledgeResponseStrategy;
  shouldCallAnswerLLM: boolean;
  lowConfidence: boolean;
  noAnswerRecommended: boolean;
  reasonCodes: string[];
  allowSoftOverviewOnLowConfidence?: boolean;
}

export function decideKnowledgePolicy(params: {
  intent: KnowledgeIntent;
  retrieval: KnowledgeRetrievalMeta | null;
  resultsCount: number;
}): KnowledgePolicyDecision {
  const { intent, retrieval, resultsCount } = params;
  const noAnswerRecommended = retrieval?.noAnswerRecommended === true;
  const lowConfidence =
    retrieval?.retrievalStatus === "low_confidence" ||
    retrieval?.confidence?.level === "low" ||
    (noAnswerRecommended && resultsCount === 0);
  const evidenceStrong =
    resultsCount > 0 && !lowConfidence && !noAnswerRecommended;
  const evidenceWeak = resultsCount === 0 || lowConfidence || noAnswerRecommended;
  const reasonCodes: string[] = [];

  if (noAnswerRecommended) reasonCodes.push("no_answer_recommended");
  if (lowConfidence) reasonCodes.push("low_confidence");
  if (resultsCount === 0) reasonCodes.push("no_results");

  if (intent === "overview") {
    const noResults = resultsCount === 0;
    return {
      mode: "overview",
      responseStrategy: noResults ? "insufficient_info" : "overview_summary",
      shouldCallAnswerLLM: !noResults,
      lowConfidence,
      noAnswerRecommended,
      reasonCodes,
      allowSoftOverviewOnLowConfidence: !noResults && lowConfidence
    };
  }

  if (intent === "ambiguous") {
    const responseStrategy = evidenceStrong ? "answer" : "clarify";
    return {
      mode: "ambiguous",
      responseStrategy,
      shouldCallAnswerLLM: true,
      lowConfidence,
      noAnswerRecommended,
      reasonCodes: responseStrategy === "answer"
        ? [...reasonCodes, "evidence_strong"]
        : [...reasonCodes, "needs_clarification"]
    };
  }

  if (noAnswerRecommended && resultsCount === 0) {
    return {
      mode: "specific",
      responseStrategy: "insufficient_info",
      shouldCallAnswerLLM: true,
      lowConfidence,
      noAnswerRecommended,
      reasonCodes: [...reasonCodes, "no_evidence"]
    };
  }

  if (evidenceWeak) {
    return {
      mode: "specific",
      responseStrategy: "clarify",
      shouldCallAnswerLLM: true,
      lowConfidence,
      noAnswerRecommended,
      reasonCodes: [...reasonCodes, "needs_clarification"]
    };
  }

  return {
    mode: "specific",
    responseStrategy: "answer",
    shouldCallAnswerLLM: true,
    lowConfidence,
    noAnswerRecommended,
    reasonCodes: [...reasonCodes, "evidence_strong"]
  };
}
