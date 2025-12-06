// src/ingestion/ingestText.ts
import { AppConfig, Client, TextChunk, ChunkWithEmbedding } from '../types.js';
import { Database } from '../db/index.js';
import { EmbeddingService } from '../embeddings/index.js';
import { chunkText } from '../chunker/index.js';
import { logger } from '../logger.js';

interface IngestDeps {
  config: AppConfig;
  db: Database;
  embeddings: EmbeddingService;
}

export interface IngestResult {
  /** How many chunks were created from the text (before DB / dedup). */
  chunksCreated: number;
  /** How many chunks we *attempted* to store (same semantics as current crawler counter). */
  chunksStored: number;
}

/**
 * Shared ingestion pipeline:
 *  text -> chunkText -> embedBatch -> insertChunkForClient
 *
 * IMPORTANT: This function assumes `text` is already "cleaned" as you want it
 * and that any minChars filtering happens *before* calling it.
 * That keeps /crawl behaviour identical to your current implementation.
 */
export async function ingestTextForClient(params: {
  text: string;
  url: string;
  domain: string;
  client: Client;
  deps: IngestDeps;
}): Promise<IngestResult> {
  const { text, url, domain, client, deps } = params;
  const { config, db, embeddings } = deps;

  const chunks: TextChunk[] = chunkText(text, url, domain, config.chunking);

  if (chunks.length === 0) {
    logger.info(`No chunks produced for ${url}`);
    return { chunksCreated: 0, chunksStored: 0 };
  }

  const texts = chunks.map((c) => c.text);

  let vectors: number[][];
  try {
    const { vectors: v, usage } = await embeddings.embedBatch(
      texts,
      client.embeddingModel,
    );
    vectors = v;

    // Track OpenAI token usage per client for ingestion (crawl/upload)
    if (usage && usage.totalTokens > 0) {
      await db.recordUsage({
        clientId: client.id,
        model: client.embeddingModel,
        operation: 'embeddings_ingest',
        promptTokens: usage.promptTokens,
        totalTokens: usage.totalTokens,
      });
    }
  } catch (err) {
    logger.error(`Embedding failed for URL ${url}`, err);
    throw err;
  }

  let stored = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const embedding = vectors[i];
    const row: ChunkWithEmbedding = { ...chunk, embedding };

    try {
      await db.insertChunkForClient(client.id, client.embeddingModel, row);
      // Note: this counts attempts, same as your previous "chunksStored" counter.
      stored += 1;
    } catch (err) {
      logger.error('Failed to store chunk in DB', err);
      // Continue with the next chunk
    }
  }

  logger.info(
    `Ingestion completed for ${url}. chunksCreated=${chunks.length}, chunksStored=${stored}`,
  );

  return { chunksCreated: chunks.length, chunksStored: stored };
}
