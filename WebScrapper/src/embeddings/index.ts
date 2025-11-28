import OpenAI from 'openai';
import { EmbeddingsConfig } from '../types.js';
import { logger } from '../logger.js';
import { EmbeddingModel, getModelDimensions } from './models.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * EmbeddingService is now multi-model:
 * - model is specified per-call (client-specific).
 * - dimensions are validated based on the model.
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
   * Embed multiple texts for a given model.
   */
  async embedBatch(
    texts: string[],
    model: EmbeddingModel,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const expectedDims = getModelDimensions(model);

    let attempt = 0;
    let backoff = this.initialBackoffMs;

    while (true) {
      try {
        const response = await this.client.embeddings.create({
          model,
          input: texts,
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

        return vectors;
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

  /**
   * Single-text convenience wrapper.
   */
  async embed(text: string, model: EmbeddingModel): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], model);
    return embedding;
  }
}
