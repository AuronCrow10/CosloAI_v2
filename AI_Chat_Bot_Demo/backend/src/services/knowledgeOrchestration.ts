import { searchKnowledgeWithMeta } from "../knowledge/client";
import { searchKnowledgeOverview } from "../knowledge/overviewRetrieval";
import type { KnowledgeIntent } from "./knowledgeIntentClassifier";
import type { SearchKnowledgeParams, KnowledgeSearchResponse } from "../knowledge/client";

export type KnowledgeRetrievalSource = "overview_retrieval" | "raw_query_retrieval";

export async function runKnowledgeRetrieval(params: {
  intent: KnowledgeIntent;
  message: string;
  clientId: string;
  domain?: string;
  ftsLanguage?: "en" | "it" | "es" | "de" | "fr";
  retrievalParams: Omit<SearchKnowledgeParams, "clientId" | "query" | "domain">;
}): Promise<{
  source: KnowledgeRetrievalSource;
  response: KnowledgeSearchResponse;
}> {
  const { intent, message, clientId, domain, ftsLanguage, retrievalParams } = params;

  if (intent === "overview") {
    const response = await searchKnowledgeOverview({
      clientId,
      domain,
      retrievalParams,
      ftsLanguage
    });
    return { source: "overview_retrieval", response };
  }

  const response = await searchKnowledgeWithMeta({
    clientId,
    domain,
    query: message,
    ...retrievalParams,
    ftsLanguage
  });
  return { source: "raw_query_retrieval", response };
}
