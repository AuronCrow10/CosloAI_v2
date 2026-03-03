import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import { applyAdaptiveLimit } from './adaptive.js';

function makeResult(params: Partial<SearchResult> & { id: string; score: number }): SearchResult {
  return {
    id: params.id,
    clientId: params.clientId ?? 'client-1',
    domain: params.domain ?? 'example.com',
    url: params.url ?? 'https://example.com/page',
    chunkIndex: params.chunkIndex ?? 0,
    text: params.text ?? 'sample text',
    createdAt: params.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    score: params.score,
  };
}

test('adaptive chooses fewer chunks on high-confidence simple query', () => {
  const results = [
    makeResult({ id: 'a', score: 0.95 }),
    makeResult({ id: 'b', score: 0.6 }),
    makeResult({ id: 'c', score: 0.4 }),
  ];
  const out = applyAdaptiveLimit({
    query: 'pricing',
    results,
    config: { minLimit: 2, maxLimit: 6, contextTokenBudget: 1000 },
  });
  assert.ok(out.results.length <= 3);
});

test('adaptive chooses more chunks on multi-part query', () => {
  const results = [
    makeResult({ id: 'a', score: 0.6 }),
    makeResult({ id: 'b', score: 0.55 }),
    makeResult({ id: 'c', score: 0.5 }),
    makeResult({ id: 'd', score: 0.45 }),
    makeResult({ id: 'e', score: 0.4 }),
  ];
  const out = applyAdaptiveLimit({
    query: 'compare pricing and features',
    results,
    config: { minLimit: 2, maxLimit: 6, contextTokenBudget: 2000 },
  });
  assert.ok(out.results.length >= 4);
});

test('token budget truncates results', () => {
  const results = [
    makeResult({ id: 'a', score: 0.9, text: 'x'.repeat(4000) }),
    makeResult({ id: 'b', score: 0.8, text: 'y'.repeat(4000) }),
    makeResult({ id: 'c', score: 0.7, text: 'z'.repeat(4000) }),
  ];
  const out = applyAdaptiveLimit({
    query: 'pricing',
    results,
    config: { minLimit: 1, maxLimit: 6, contextTokenBudget: 500 },
  });
  assert.ok(out.results.length <= 2);
});

test('min/max bounds respected', () => {
  const results = [
    makeResult({ id: 'a', score: 0.9 }),
    makeResult({ id: 'b', score: 0.8 }),
    makeResult({ id: 'c', score: 0.7 }),
    makeResult({ id: 'd', score: 0.6 }),
  ];
  const out = applyAdaptiveLimit({
    query: 'pricing and refunds and cancellation',
    results,
    config: { minLimit: 3, maxLimit: 3, contextTokenBudget: 2000 },
  });
  assert.equal(out.results.length, 3);
});
