import crypto from 'node:crypto';
import { ChunkingConfig, TextChunk } from '../types.js';
import { tokenize, detokenize } from '../tokenizer/index.js';

/**
 * Chunking livello 2:
 * - chunk per paragrafi/logical blocks (split su \n\n)
 * - packing di più paragrafi in un chunk fino a chunkSizeTokens
 * - overlap di token tra chunk successivi
 * - fallback: se un singolo paragrafo è troppo lungo, viene spezzato con sliding window interna
 */
export function chunkText(
  text: string,
  url: string,
  domain: string,
  config: ChunkingConfig,
): TextChunk[] {
  const chunkSizeTokens: number = config.chunkSizeTokens;
  const chunkOverlapTokens: number = config.chunkOverlapTokens;

  // 1) Dividi il testo in paragrafi logici (cleanedText ha già \n\n tra blocchi)
  const paragraphs: string[] = text
    .split(/\n{2,}/)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 0);

  if (paragraphs.length === 0) return [];

  const chunks: TextChunk[] = [];
  let chunkIndex: number = 0;

  // Tokens correnti del chunk che stiamo costruendo
  let currentTokens: number[] = [];
  // Tokens dell'ultimo chunk "flushed" (per overlap)
  let lastChunkTokens: number[] | null = null;

  // Separator tokens tra paragrafi all'interno dello stesso chunk
  const sepTokens: number[] = tokenize('\n\n');

  const flushCurrentAsChunk = (): void => {
    if (!currentTokens.length) return;

    const chunkTextStr: string = detokenize(currentTokens).trim();
    if (!chunkTextStr) {
      currentTokens = [];
      return;
    }

    const chunkHash: string = crypto
      .createHash('sha256')
      .update(chunkTextStr)
      .digest('hex');

    const row: TextChunk = {
      domain,
      url,
      chunkIndex,
      text: chunkTextStr,
      chunkHash,
    };

    chunks.push(row);

    chunkIndex += 1;
    // Salva i token del chunk appena creato per l'overlap
    lastChunkTokens = currentTokens.slice();
    // Svuota il buffer corrente
    currentTokens = [];
  };

  for (const para of paragraphs) {
    const paraTokens: number[] = tokenize(para);
    if (paraTokens.length === 0) continue;

    // 2) Caso speciale: paragrafo singolo più lungo di chunkSizeTokens
    //    → spezzalo con sliding window interna, mantenendo overlap
    if (paraTokens.length > chunkSizeTokens) {
      // Chiudi eventuale chunk parziale prima di gestire questo "mostro"
      flushCurrentAsChunk();

      let start: number = 0;
      while (start < paraTokens.length) {
        const end: number = Math.min(start + chunkSizeTokens, paraTokens.length);
        const windowTokens: number[] = paraTokens.slice(start, end);

        currentTokens = windowTokens.slice();
        flushCurrentAsChunk();

        if (end === paraTokens.length) {
          // Prepara overlap per il contenuto successivo
          const len: number = windowTokens.length;
          const startOverlap: number = Math.max(0, len - chunkOverlapTokens);
          currentTokens = windowTokens.slice(startOverlap);
          break;
        }

        start = Math.max(0, end - chunkOverlapTokens);
      }

      // Passa al prossimo paragrafo
      continue;
    }

    // 3) Prova ad aggiungere questo paragrafo al chunk corrente
    const needSep: boolean = currentTokens.length > 0;
    const neededTokensCount: number =
      (needSep ? sepTokens.length : 0) + paraTokens.length;

    // Se non ci sta → chiudi il chunk corrente e aprine uno nuovo con overlap
    if (currentTokens.length + neededTokensCount > chunkSizeTokens) {
      flushCurrentAsChunk();

      // Riparti con overlap dall'ultimo chunk (se esiste)
      currentTokens = [];

      if (lastChunkTokens && chunkOverlapTokens > 0) {
        // Cast esplicito per evitare qualsiasi inferenza strana (never, ecc.)
        const base: number[] = lastChunkTokens as number[];
        const baseLength: number = base.length;
        const startOverlap: number = Math.max(
          0,
          baseLength - chunkOverlapTokens,
        );
        const overlapSlice: number[] = base.slice(startOverlap);
        if (overlapSlice.length > 0) {
          currentTokens.push(...overlapSlice);
        }
      }
    }

    // Ora aggiungi il paragrafo al chunk corrente (eventualmente con separatore)
    if (currentTokens.length > 0) {
      currentTokens.push(...sepTokens);
    }
    currentTokens.push(...paraTokens);
  }

  // 4) Flush finale dell'ultimo chunk parziale
  flushCurrentAsChunk();

  return chunks;
}
