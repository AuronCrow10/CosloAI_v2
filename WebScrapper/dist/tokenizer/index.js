import { encode, decode } from 'gpt-tokenizer';
/**
 * Tokenize text into OpenAI-compatible tokens.
 * Returns an array of token IDs.
 */
export function tokenize(text) {
    return encode(text);
}
/**
 * Decode a token ID array back into text.
 */
export function detokenize(tokens) {
    return decode(tokens);
}
