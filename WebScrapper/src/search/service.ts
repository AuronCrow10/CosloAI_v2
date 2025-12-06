import { Database } from '../db/index.js';
import { EmbeddingService } from '../embeddings/index.js';
import { Client, SearchResult } from '../types.js';

export interface SearchOptions {
  domain?: string;
  limit?: number;
}

/**
 * High-level search helper:
 * - embeds the query using the client's embedding_model,
 * - runs a similarity search against the appropriate table.
 */
export async function searchClientContent(params: {
  db: Database;
  embeddings: EmbeddingService;
  client: Client;
  query: string;
  options?: SearchOptions;
}): Promise<SearchResult[]> {
  const { db, embeddings, client, query, options } = params;

  const model = client.embeddingModel;

  const { vectors, usage } = await embeddings.embedBatch([query], model);
  const [queryEmbedding] = vectors;

  // Track OpenAI token usage per client for searches
  if (usage && usage.totalTokens > 0) {
    await db.recordUsage({
      clientId: client.id,
      model,
      operation: 'embeddings_search',
      promptTokens: usage.promptTokens,
      totalTokens: usage.totalTokens,
    });
  }

  const results = await db.searchClientChunks({
    clientId: client.id,
    model,
    queryEmbedding,
    domain: options?.domain,
    limit: options?.limit ?? 10,
  });

  return results;
}
