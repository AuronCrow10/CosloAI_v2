import type { SearchResult } from '../types.js';

export interface AdjacentOptions {
  includeAdjacent: boolean;
  adjacentWindow: number;
  stitchChunks: boolean;
}

export interface AdjacentDebug {
  includeAdjacent: boolean;
  adjacentWindow: number;
  stitchChunks: boolean;
  anchors: number;
  stitchedBlocks: number;
  skippedOverlaps: number;
}

export type AdjacentChunk = Pick<
  SearchResult,
  'id' | 'clientId' | 'domain' | 'url' | 'sourceId' | 'chunkIndex' | 'text' | 'createdAt'
>;

type Range = { start: number; end: number };

function rangesOverlap(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function normalizeWindow(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const clamped = Math.max(0, Math.min(2, Math.floor(value)));
  return clamped;
}

function computeOverlapSuffixPrefix(prev: string, next: string, maxOverlap = 200): number {
  const maxLen = Math.min(maxOverlap, prev.length, next.length);
  if (maxLen === 0) return 0;

  for (let size = maxLen; size >= 10; size -= 1) {
    const suffix = prev.slice(prev.length - size);
    const prefix = next.slice(0, size);
    if (suffix === prefix) return size;
  }
  return 0;
}

function stitchTexts(chunks: AdjacentChunk[]): string {
  if (chunks.length === 0) return '';
  let output = chunks[0].text ?? '';
  for (let i = 1; i < chunks.length; i += 1) {
    const next = chunks[i].text ?? '';
    const overlap = computeOverlapSuffixPrefix(output, next);
    output += overlap > 0 ? next.slice(overlap) : `\n\n${next}`;
  }
  return output.trim();
}

export function buildAdjacentResults(params: {
  anchors: SearchResult[];
  chunkLookup: Map<string, AdjacentChunk[]>;
  options: AdjacentOptions;
}): { results: SearchResult[]; debug: AdjacentDebug } {
  const { anchors, chunkLookup, options } = params;
  const window = normalizeWindow(options.adjacentWindow);

  if (!options.includeAdjacent || window === 0) {
    return {
      results: anchors,
      debug: {
        includeAdjacent: options.includeAdjacent,
        adjacentWindow: window,
        stitchChunks: options.stitchChunks,
        anchors: anchors.length,
        stitchedBlocks: anchors.length,
        skippedOverlaps: 0,
      },
    };
  }

  const acceptedRanges = new Map<string, Range[]>();
  const results: SearchResult[] = [];
  let skippedOverlaps = 0;

  for (const anchor of anchors) {
    const sourceKey = getSourceKey(anchor);
    const range: Range = {
      start: anchor.chunkIndex - window,
      end: anchor.chunkIndex + window,
    };

    const existing = acceptedRanges.get(sourceKey) ?? [];
    if (existing.some((r) => rangesOverlap(r, range))) {
      skippedOverlaps += 1;
      continue;
    }
    existing.push(range);
    acceptedRanges.set(sourceKey, existing);

    const candidates = (chunkLookup.get(sourceKey) ?? []).filter(
      (c) => c.chunkIndex >= range.start && c.chunkIndex <= range.end,
    );
    candidates.sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (!options.stitchChunks) {
      for (const c of candidates) {
        results.push({
          ...anchor,
          id: c.id,
          clientId: c.clientId,
          domain: c.domain,
          url: c.url,
          chunkIndex: c.chunkIndex,
          text: c.text,
          createdAt: c.createdAt,
          anchorChunkId: anchor.id,
          chunkRangeStart: range.start,
          chunkRangeEnd: range.end,
          stitchedChunkIds: undefined,
        });
      }
      continue;
    }

    const stitchedText = stitchTexts(candidates);
    const stitchedChunkIds = candidates.map((c) => c.id);

    results.push({
      ...anchor,
      text: stitchedText,
      anchorChunkId: anchor.id,
      chunkRangeStart: range.start,
      chunkRangeEnd: range.end,
      stitchedChunkIds,
    });
  }

  return {
    results,
    debug: {
      includeAdjacent: options.includeAdjacent,
      adjacentWindow: window,
      stitchChunks: options.stitchChunks,
      anchors: anchors.length,
      stitchedBlocks: results.length,
      skippedOverlaps,
    },
  };
}
function getSourceKey(result: { sourceId?: string | null; url: string }): string {
  return result.sourceId ? `source:${result.sourceId}` : `url:${result.url}`;
}
