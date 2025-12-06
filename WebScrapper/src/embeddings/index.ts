import OpenAI from 'openai';
import { EmbeddingsConfig } from '../types.js';
import { logger } from '../logger.js';
import { EmbeddingModel, getModelDimensions } from './models.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbeddingBatchResult {
  vectors: number[][];
  usage?: EmbeddingUsage;
}

/**
 * EmbeddingService is now multi-model:
 * - model is specified per-call (client-specific).
 * - dimensions are validated based on the model.
 * - embedBatch batches requests for OpenAI limits and returns token usage.
 */
export class EmbeddingService {
  private client: OpenAI;
  private maxRetries: number;
  private initialBackoffMs: number;

  constructor(config: EmbeddingsConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.maxRetries = config.maxRetries;
    this.initialBackoffMs = config.initialBackoffMs;
  }

  /**
   * Embed multiple texts for a given model, with internal batching.
   * Returns both the vectors and the total token usage as reported by OpenAI.
   */
  async embedBatch(
    texts: string[],
    model: EmbeddingModel,
  ): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: undefined };
    }

    const expectedDims = getModelDimensions(model);
    const allVectors: number[][] = [];

    let totalPromptTokens = 0;
    let totalTokens = 0;

    // Conservative batch size to respect OpenAI limits and keep retries cheap
    const maxBatchSize = 64;

    for (let i = 0; i < texts.length; i += maxBatchSize) {
      const slice = texts.slice(i, i + maxBatchSize);

      let attempt = 0;
      let backoff = this.initialBackoffMs;

      // Retry per batch on 429/5xx
      while (true) {
        try {
          const response = await this.client.embeddings.create({
            model,
            input: slice,
          });

          const vectors = response.data.map(
            (row) => row.embedding as unknown as number[],
          );

          for (const v of vectors) {
            if (v.length !== expectedDims) {
              throw new Error(
                `Embedding API returned dimension ${v.length}, expected ${expectedDims} ` +
                  `for model "${model}". Check OpenAI docs / model.`,
              );
            }
          }

          allVectors.push(...vectors);

          const usage = (response as any).usage;
          if (usage) {
            // For embeddings, OpenAI reports prompt_tokens and total_tokens.
            totalPromptTokens += usage.prompt_tokens ?? 0;
            totalTokens += usage.total_tokens ?? 0;
          }

          // Batch succeeded, move to next
          break;
        } catch (err: any) {
          const status = err?.status ?? err?.response?.status;
          const isRetryable =
            status === 429 || (status >= 500 && status < 600);

          attempt += 1;

          if (!isRetryable || attempt > this.maxRetries) {
            logger.error(
              `Embedding API failed (attempt ${attempt}, status ${status}). Giving up.`,
              err,
            );
            throw err;
          }

          logger.warn(
            `Embedding API rate-limited or server error (status ${status}). ` +
              `Retrying in ${backoff}ms (attempt ${attempt}/${this.maxRetries})`,
          );
          await sleep(backoff);
          backoff *= 2;
        }
      }
    }

    const usage: EmbeddingUsage | undefined =
      totalTokens > 0 || totalPromptTokens > 0
        ? {
            promptTokens: totalPromptTokens,
            totalTokens,
          }
        : undefined;

    return { vectors: allVectors, usage };
  }

  /**
   * Single-text convenience wrapper.
   */
  async embed(text: string, model: EmbeddingModel): Promise<number[]> {
    const { vectors } = await this.embedBatch([text], model);
    return vectors[0] ?? [];
  }
}
