import type { EmbeddingModel } from './embeddings/models.js';

export interface CrawlConfig {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  contentWaitSelector?: string;
  minChars: number;
  enableSitemap: boolean;
}

export interface ChunkingConfig {
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
}

export interface EmbeddingsConfig {
  apiKey: string;
  maxRetries: number;
  initialBackoffMs: number;
}

export interface DbConfig {
  connectionString: string;
}

export interface AppConfig {
  db: DbConfig;
  embeddings: EmbeddingsConfig;
  crawl: CrawlConfig;
  chunking: ChunkingConfig;
}

export interface ParsedPage {
  url: string;
  domain: string;
  title?: string;
  rawHtml: string;
  rawText: string;
  cleanedText: string;
}

export interface TextChunk {
  domain: string;
  url: string;
  chunkIndex: number;
  text: string;
  /** Global deduplication hash (SHA-256 of chunk_text) */
  chunkHash: string;
}

export interface ChunkWithEmbedding extends TextChunk {
  embedding: number[];
}

/**
 * Client configuration stored in the database.
 */
export interface Client {
  id: string;
  name: string;
  embeddingModel: EmbeddingModel;
  mainDomain?: string | null;
  createdAt: Date;
}

/**
 * Result of a semantic search against page_chunks_* tables.
 */
export interface SearchResult {
  id: string;
  clientId: string;
  domain: string;
  url: string;
  chunkIndex: number;
  text: string;
  score: number; // higher = more similar
  createdAt: Date;
}
