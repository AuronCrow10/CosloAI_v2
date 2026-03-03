import type { SearchResult } from '../types.js';
import {
  DEFAULT_MAX_PER_SOURCE,
  DEFAULT_NEAR_DUPLICATE_THRESHOLD,
} from './qualityConfig.js';

export interface SelectionOptions {
  dedupeResults: boolean;
  diversifySources: boolean;
  maxPerSource?: number;
  nearDuplicateThreshold?: number;
  finalLimit: number;
}

export interface DedupeDebug {
  dedupedCount: number;
  removed: Array<{ id: string; reason: string }>;
  sourceDistributionBefore: Record<string, number>;
  sourceDistributionAfter: Record<string, number>;
  decisions: Array<{ id: string; selected: boolean; reason: string }>;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

function tokenize(value: string): string[] {
  if (!value) return [];
  return normalizeText(value).split(' ').filter(Boolean);
}

function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function getSourceKey(result: SearchResult): string {
  if (result.sourceId) return `source:${result.sourceId}`;
  return result.url || result.domain;
}

export function applyDedupeAndDiversity(params: {
  results: SearchResult[];
  options: SelectionOptions;
}): { results: SearchResult[]; debug: DedupeDebug } {
  const { results, options } = params;
  const maxPerSource = options.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const threshold = options.nearDuplicateThreshold ?? DEFAULT_NEAR_DUPLICATE_THRESHOLD;

  const removed: Array<{ id: string; reason: string }> = [];
  const decisions: Array<{ id: string; selected: boolean; reason: string }> = [];

  const sourceDistributionBefore: Record<string, number> = {};
  for (const r of results) {
    const key = getSourceKey(r);
    sourceDistributionBefore[key] = (sourceDistributionBefore[key] || 0) + 1;
  }

  let filtered = results.slice();

  if (options.dedupeResults) {
    const seenExact = new Map<string, string>();
    const seenTokens: Array<{ id: string; tokens: string[] }> = [];
    const deduped: SearchResult[] = [];

    for (const r of filtered) {
      const normalized = normalizeText(r.text || '');
      if (!normalized) {
        deduped.push(r);
        decisions.push({ id: r.id, selected: true, reason: 'empty-text' });
        continue;
      }

      const exactKey = normalized;
      if (seenExact.has(exactKey)) {
        removed.push({ id: r.id, reason: 'exact-duplicate' });
        decisions.push({ id: r.id, selected: false, reason: 'exact-duplicate' });
        continue;
      }

      const tokens = tokenize(r.text || '');
      let isNearDup = false;
      for (const prev of seenTokens) {
        const ratio = overlapRatio(tokens, prev.tokens);
        if (ratio >= threshold) {
          removed.push({ id: r.id, reason: 'near-duplicate' });
          decisions.push({ id: r.id, selected: false, reason: 'near-duplicate' });
          isNearDup = true;
          break;
        }
      }

      if (isNearDup) continue;

      seenExact.set(exactKey, r.id);
      seenTokens.push({ id: r.id, tokens });
      deduped.push(r);
      decisions.push({ id: r.id, selected: true, reason: 'unique' });
    }

    filtered = deduped;
  }

  if (options.diversifySources) {
    const perSourceCount: Record<string, number> = {};
    const diversified: SearchResult[] = [];

    for (const r of filtered) {
      if (diversified.length >= options.finalLimit) break;
      const key = getSourceKey(r);
      const count = perSourceCount[key] ?? 0;
      if (count >= maxPerSource) {
        removed.push({ id: r.id, reason: 'source-cap' });
        decisions.push({ id: r.id, selected: false, reason: 'source-cap' });
        continue;
      }
      perSourceCount[key] = count + 1;
      diversified.push(r);
      if (!options.dedupeResults) {
        decisions.push({ id: r.id, selected: true, reason: 'source-ok' });
      }
    }

    filtered = diversified;
  }

  const finalResults = filtered.slice(0, options.finalLimit);

  const sourceDistributionAfter: Record<string, number> = {};
  for (const r of finalResults) {
    const key = getSourceKey(r);
    sourceDistributionAfter[key] = (sourceDistributionAfter[key] || 0) + 1;
  }

  return {
    results: finalResults,
    debug: {
      dedupedCount: removed.length,
      removed,
      sourceDistributionBefore,
      sourceDistributionAfter,
      decisions,
    },
  };
}
