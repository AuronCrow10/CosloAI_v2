import axios from "axios";
import { config } from "../config";

export interface KnowledgeSearchResult {
  id: string;
  clientId: string;
  domain: string;
  url: string;
  chunkIndex: number;
  text: string;
  score: number;
  createdAt: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
}

export async function searchKnowledge(params: {
  clientId: string;
  query: string;
  domain?: string;
  limit?: number;
}): Promise<KnowledgeSearchResult[]> {
  const { clientId, query, domain, limit = 5 } = params;

  console.log(clientId, query, domain);

  const url = `${config.knowledgeBaseUrl}/search`;

  const response = await axios.post<KnowledgeSearchResponse>(
    url,
    {
      clientId,
      query,
     // domain,
      limit
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": config.knowledgeInternalToken
      },
      timeout: 10_000
    }
  );

  if (!response.data || !Array.isArray(response.data.results)) {
    throw new Error("Invalid response from Knowledge Backend");
  }

  return response.data.results;
}
