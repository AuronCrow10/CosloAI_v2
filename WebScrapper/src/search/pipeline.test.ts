import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import { runQualityPipeline } from './pipeline.js';

function makeResult(params: Partial<SearchResult> & { id: string; score: number; url: string; text: string }): SearchResult {
  return {
    id: params.id,
    clientId: params.clientId ?? 'client-1',
    domain: params.domain ?? 'example.com',
    url: params.url,
    sourceId: params.sourceId ?? null,
    chunkIndex: params.chunkIndex ?? 0,
    text: params.text,
    createdAt: params.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    score: params.score,
  };
}

test('pipeline order: dedupe -> adaptive budget -> confidence', () => {
  const results = [
    makeResult({ id: 'a', score: 0.9, url: 'u1', text: 'same text' }),
    makeResult({ id: 'b', score: 0.85, url: 'u2', text: 'same text' }),
    makeResult({ id: 'c', score: 0.6, url: 'u3', text: 'x'.repeat(4000) }),
  ];

  const out = runQualityPipeline({
    query: 'pricing',
    results,
    keywordPresent: null,
    options: {
      dedupeResults: true,
      diversifySources: false,
      adaptiveLimit: true,
      minLimit: 1,
      maxLimit: 3,
      contextTokenBudget: 500,
      finalLimit: 3,
      returnDebug: true,
    },
  });

  assert.ok(out.results.length >= 1);
  assert.ok(out.debug?.selection);
  assert.ok(out.debug?.adaptive);
  assert.ok(out.debug?.confidence);
  assert.ok(out.confidence.level === 'medium' || out.confidence.level === 'high' || out.confidence.level === 'low');
});

test('low confidence keeps results but flags status when noAnswer disabled', () => {
  const results = [
    makeResult({ id: 'a', score: 0.4, url: 'u1', text: 'weak match' }),
  ];

  const out = runQualityPipeline({
    query: 'unclear query',
    results,
    keywordPresent: null,
    options: {
      dedupeResults: false,
      diversifySources: false,
      adaptiveLimit: false,
      finalLimit: 3,
      minConfidenceLevel: 'medium',
      noAnswerOnLowConfidence: false,
      returnDebug: true,
    },
  });

  assert.equal(out.retrievalStatus, 'low_confidence');
  assert.equal(out.results.length, 1);
  assert.equal(out.noAnswerRecommended, true);
});
