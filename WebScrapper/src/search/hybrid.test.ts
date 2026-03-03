import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import {
  buildHybridResults,
  finalizeVectorResults,
} from './hybrid.js';

function makeResult(params: Partial<SearchResult> & { id: string; score: number }): SearchResult {
  return {
    id: params.id,
    clientId: params.clientId ?? 'client-1',
    domain: params.domain ?? 'example.com',
    url: params.url ?? 'https://example.com/page',
    chunkIndex: params.chunkIndex ?? 0,
    text: params.text ?? 'sample',
    createdAt: params.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    score: params.score,
  };
}

test('vector-only strategy keeps ordering and scores', () => {
  const input = [makeResult({ id: 'a', score: 0.9 }), makeResult({ id: 'b', score: 0.5 })];
  const output = finalizeVectorResults(input, 10);
  assert.equal(output.length, 2);
  assert.equal(output[0].id, 'a');
  assert.equal(output[0].score, 0.9);
  assert.equal(output[1].id, 'b');
  assert.equal(output[1].score, 0.5);
});

test('hybrid merge dedupes by id and ranks with combined score', () => {
  const vector = [makeResult({ id: 'a', score: 0.9 })];
  const keyword = [makeResult({ id: 'a', score: 0.2 }), makeResult({ id: 'b', score: 1.0 })];

  const { results } = buildHybridResults({
    vectorCandidates: vector,
    keywordCandidates: keyword,
    finalLimit: 10,
  });

  const ids = results.map((r) => r.id);
  assert.deepEqual(ids.sort(), ['a', 'b']);
});

test('hybrid scoring handles empty candidate sets', () => {
  const { results } = buildHybridResults({
    vectorCandidates: [],
    keywordCandidates: [],
    finalLimit: 10,
  });
  assert.equal(results.length, 0);
});
