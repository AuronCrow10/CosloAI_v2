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

export type CrawlJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type KnowledgeJobType = 'domain' | 'docs';

/**
 * Internal DB row representation of crawl_jobs.
 * (Note: jobType is NOT stored in the table; it is inferred in server.ts.)
 */
export interface CrawlJob {
  id: string;
  clientId: string;
  domain: string;
  startUrl: string;
  status: CrawlJobStatus;
  totalPagesEstimated: number | null;
  pagesVisited: number;
  pagesStored: number;
  chunksStored: number;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

/**
 * What the UI consumes.
 * jobType + origin are derived (domain vs local upload filename).
 */
export interface CrawlJobPublicView {
  id: string;
  clientId: string; // ownership validation
  status: CrawlJobStatus;

  jobType: KnowledgeJobType;

  /**
   * Domain job: domain (e.g. "example.com")
   * Docs job: filename (e.g. "pricing.pdf")
   */
  origin: string;

  /**
   * Storage/grouping namespace used for chunks (not the "origin" of the file).
   * For domain jobs it's the domain, for docs it may be bot's domain or "uploaded-docs".
   */
  domain: string;

  startUrl: string;

  pagesVisited: number;
  pagesStored: number;
  chunksStored: number;
  totalPagesEstimated: number | null;
  percent: number | null;
  errorMessage: string | null;

  // Best-effort token usage for this job window (from client_usage)
  tokensUsed: number | null;

  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface CrawlEstimate {
  domain: string;
  pagesEstimated: number;
  samplePages: number;
  avgEmbeddingTokensPerPage: number;
  tokensEstimated: number;
  tokensLow: number;
  tokensHigh: number;
}

export interface DocsEstimateFile {
  fileName: string;
  chars: number;
  chunks: number;
  tokensEstimated: number;
  skipped?: boolean;
  reason?: string;
}

export interface DocsEstimate {
  totalTokensEstimated: number;
  files: DocsEstimateFile[];
}
