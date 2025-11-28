import { encode, decode } from 'gpt-tokenizer';

/**
 * Tokenize text into OpenAI-compatible tokens.
 * Returns an array of token IDs.
 */
export function tokenize(text: string): number[] {
  return encode(text);
}

/**
 * Decode a token ID array back into text.
 */
export function detokenize(tokens: number[]): string {
  return decode(tokens);
}
