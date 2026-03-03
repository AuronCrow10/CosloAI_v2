import { Database } from '../db/index.js';
import { EmbeddingService } from '../embeddings/index.js';
import { Client, SearchResult } from '../types.js';
import {
  buildHybridResults,
  finalizeVectorResults,
  type HybridScoreBreakdown,
  type SearchStrategy,
} from './hybrid.js';
import {
  buildAdjacentResults,
  type AdjacentDebug,
  type AdjacentChunk,
} from './adjacent.js';
import {
  type DedupeDebug,
} from './selection.js';
import {
  type AdaptiveDebug,
} from './adaptive.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
} from './qualityConfig.js';
import {
  type ConfidenceLevel,
  type ConfidenceSummary,
} from './confidence.js';
import { runQualityPipeline } from './pipeline.js';

export interface SearchOptions {
  domain?: string;
  limit?: number;
  finalLimit?: number;
  candidateLimit?: number;
  strategy?: SearchStrategy;
  returnDebug?: boolean;
  ftsLanguage?: string;
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
  minConfidenceLevel?: ConfidenceLevel;
  noAnswerOnLowConfidence?: boolean;
}

export interface SearchDebug {
  strategy: SearchStrategy;
  candidateCounts: {
    vector: number;
    keyword: number;
    merged: number;
  };
  results?: HybridScoreBreakdown[];
  adjacent?: AdjacentDebug;
  selection?: DedupeDebug;
  adaptive?: AdaptiveDebug;
  confidence?: ConfidenceSummary;
}

export interface SearchResponse {
  results: SearchResult[];
  retrievalStatus?: 'ok' | 'low_confidence';
  noAnswerRecommended?: boolean;
  confidence?: ConfidenceSummary;
  debug?: SearchDebug;
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
}): Promise<SearchResponse> {
  const { db, embeddings, client, query, options } = params;

  const model = client.embeddingModel;

  const strategy: SearchStrategy = options?.strategy ?? 'vector';
  const finalLimit = options?.finalLimit ?? options?.limit ?? 10;
  const candidateLimit = options?.candidateLimit ?? 30;

  let baseResults: SearchResult[] = [];
  let debug: SearchDebug | undefined;
  let keywordPresent: boolean | null = null;

  if (strategy === 'vector') {
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
      limit: finalLimit,
    });

    baseResults = finalizeVectorResults(results, finalLimit);
    if (options?.returnDebug) {
      debug = {
        strategy,
        candidateCounts: {
          vector: results.length,
          keyword: 0,
          merged: results.length,
        },
      };
    }
  } else {
    const { vectors, usage } = await embeddings.embedBatch([query], model);
    const [queryEmbedding] = vectors;

    if (usage && usage.totalTokens > 0) {
      await db.recordUsage({
        clientId: client.id,
        model,
        operation: 'embeddings_search',
        promptTokens: usage.promptTokens,
        totalTokens: usage.totalTokens,
      });
    }

    const [vectorCandidates, keywordCandidates] = await Promise.all([
      db.searchClientChunks({
        clientId: client.id,
        model,
        queryEmbedding,
        domain: options?.domain,
        limit: candidateLimit,
      }),
      db.searchClientChunksKeyword({
        clientId: client.id,
        model,
        query,
        domain: options?.domain,
        limit: candidateLimit,
        ftsLanguage: options?.ftsLanguage,
      }),
    ]);

    const { results, breakdown } = buildHybridResults({
      vectorCandidates,
      keywordCandidates,
      finalLimit,
    });

    baseResults = results;
    keywordPresent = keywordCandidates.length > 0;
    if (options?.returnDebug) {
      debug = {
        strategy,
        candidateCounts: {
          vector: vectorCandidates.length,
          keyword: keywordCandidates.length,
          merged: new Set([
            ...vectorCandidates.map((r) => r.id),
            ...keywordCandidates.map((r) => r.id),
          ]).size,
        },
        results: breakdown,
      };
    }
  }

  const includeAdjacent = options?.includeAdjacent === true;
  const stitchChunks =
    typeof options?.stitchChunks === 'boolean' ? options?.stitchChunks : includeAdjacent;
  const adjacentWindow = options?.adjacentWindow ?? 1;

  if (!includeAdjacent) {
    const pipeline = runQualityPipeline({
      query,
      results: baseResults,
      keywordPresent,
      options: {
        dedupeResults: options?.dedupeResults ?? false,
        diversifySources: options?.diversifySources ?? false,
        maxPerSource: options?.maxPerSource,
        nearDuplicateThreshold: options?.nearDuplicateThreshold,
        adaptiveLimit: options?.adaptiveLimit ?? false,
        minLimit: options?.minLimit ?? DEFAULT_ADAPTIVE_CONFIG.minLimit,
        maxLimit: options?.maxLimit ?? DEFAULT_ADAPTIVE_CONFIG.maxLimit,
        contextTokenBudget:
          options?.contextTokenBudget ??
          DEFAULT_ADAPTIVE_CONFIG.contextTokenBudget,
        minConfidenceLevel: options?.minConfidenceLevel ?? 'low',
        noAnswerOnLowConfidence: options?.noAnswerOnLowConfidence ?? false,
        finalLimit,
        returnDebug: options?.returnDebug ?? false,
        limitOverride: typeof options?.limit === 'number' ? options?.limit : undefined,
      },
    });

    if (debug && options?.returnDebug) {
      debug.selection = pipeline.debug?.selection;
      debug.adaptive = pipeline.debug?.adaptive;
      debug.confidence = pipeline.debug?.confidence;
    }

    return {
      results: pipeline.results,
      retrievalStatus: pipeline.retrievalStatus,
      noAnswerRecommended: pipeline.noAnswerRecommended,
      confidence: pipeline.confidence,
      debug,
    };
  }

  const sourceKeys = Array.from(
    new Set(baseResults.map((r) => (r.sourceId ? `source:${r.sourceId}` : `url:${r.url}`))),
  );
  const window = Math.max(0, Math.min(2, Math.floor(adjacentWindow)));
  const chunkLookup = new Map<string, AdjacentChunk[]>();

  for (const key of sourceKeys) {
    const anchorsForKey = baseResults.filter((r) =>
      r.sourceId ? `source:${r.sourceId}` === key : `url:${r.url}` === key,
    );
    const minIndex = Math.min(...anchorsForKey.map((r) => r.chunkIndex - window));
    const maxIndex = Math.max(...anchorsForKey.map((r) => r.chunkIndex + window));
    const sourceId = anchorsForKey[0]?.sourceId ?? null;
    const url = anchorsForKey[0]?.url ?? '';
    const chunks = await db.listChunksForClientBySourceRange({
      clientId: client.id,
      model,
      sourceId: sourceId ?? null,
      url,
      minIndex,
      maxIndex,
    });
    chunkLookup.set(key, chunks);
  }

  const { results: adjacentResults, debug: adjacentDebug } = buildAdjacentResults({
    anchors: baseResults,
    chunkLookup,
    options: { includeAdjacent, adjacentWindow: window, stitchChunks },
  });

  if (debug) {
    debug.adjacent = adjacentDebug;
  } else if (options?.returnDebug) {
    debug = {
      strategy,
      candidateCounts: {
        vector: baseResults.length,
        keyword: 0,
        merged: baseResults.length,
      },
      adjacent: adjacentDebug,
    };
  }

  const pipeline = runQualityPipeline({
    query,
    results: adjacentResults,
    keywordPresent,
    options: {
      dedupeResults: options?.dedupeResults ?? false,
      diversifySources: options?.diversifySources ?? false,
      maxPerSource: options?.maxPerSource,
      nearDuplicateThreshold: options?.nearDuplicateThreshold,
      adaptiveLimit: options?.adaptiveLimit ?? false,
      minLimit: options?.minLimit ?? DEFAULT_ADAPTIVE_CONFIG.minLimit,
      maxLimit: options?.maxLimit ?? DEFAULT_ADAPTIVE_CONFIG.maxLimit,
      contextTokenBudget:
        options?.contextTokenBudget ??
        DEFAULT_ADAPTIVE_CONFIG.contextTokenBudget,
      minConfidenceLevel: options?.minConfidenceLevel ?? 'low',
      noAnswerOnLowConfidence: options?.noAnswerOnLowConfidence ?? false,
      finalLimit,
      returnDebug: options?.returnDebug ?? false,
      limitOverride: typeof options?.limit === 'number' ? options?.limit : undefined,
    },
  });

  if (debug && options?.returnDebug) {
    debug.selection = pipeline.debug?.selection;
    debug.adaptive = pipeline.debug?.adaptive;
    debug.confidence = pipeline.debug?.confidence;
  }

  return {
    results: pipeline.results,
    retrievalStatus: pipeline.retrievalStatus,
    noAnswerRecommended: pipeline.noAnswerRecommended,
    confidence: pipeline.confidence,
    debug,
  };
}
