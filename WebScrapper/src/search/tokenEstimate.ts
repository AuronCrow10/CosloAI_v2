import { tokenize } from '../tokenizer/index.js';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return tokenize(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
