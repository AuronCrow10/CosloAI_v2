import crypto from 'node:crypto';
import { ChunkingConfig, TextChunk } from '../types.js';
import { tokenize, detokenize } from '../tokenizer/index.js';

/**
 * Token-based sliding window chunker with overlap.
 * Uses an OpenAI-compatible tokenizer (gpt-tokenizer).
 *
 * - chunkSizeTokens: target tokens per chunk (e.g. 900)
 * - chunkOverlapTokens: overlap between successive chunks (e.g. 150)
 */
export function chunkText(
  text: string,
  url: string,
  domain: string,
  config: ChunkingConfig,
): TextChunk[] {
  const { chunkSizeTokens, chunkOverlapTokens } = config;

  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < tokens.length) {
    const end = Math.min(start + chunkSizeTokens, tokens.length);
    const tokenSlice = tokens.slice(start, end);
    const chunkText = detokenize(tokenSlice).trim();

    if (chunkText.length > 0) {
      const chunkHash = crypto
        .createHash('sha256')
        .update(chunkText)
        .digest('hex');

      chunks.push({
        domain,
        url,
        chunkIndex,
        text: chunkText,
        chunkHash,
      });

      chunkIndex += 1;
    }

    if (end === tokens.length) break;

    // Sliding window with overlap
    start = Math.max(0, end - chunkOverlapTokens);
  }

  return chunks;
}
