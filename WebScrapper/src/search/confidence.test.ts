import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import { computeConfidence } from './confidence.js';

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

test('high confidence on strong top score and gap', () => {
  const results = [
    makeResult({ id: 'a', score: 0.95 }),
    makeResult({ id: 'b', score: 0.7 }),
    makeResult({ id: 'c', score: 0.4 }),
  ];
  const conf = computeConfidence({ results, includeSignals: true });
  assert.equal(conf.level, 'high');
});

test('low confidence on weak/flat results', () => {
  const results = [
    makeResult({ id: 'a', score: 0.5 }),
    makeResult({ id: 'b', score: 0.48 }),
    makeResult({ id: 'c', score: 0.47 }),
  ];
  const conf = computeConfidence({ results, includeSignals: true });
  assert.equal(conf.level, 'low');
});

test('low confidence on empty results', () => {
  const conf = computeConfidence({ results: [] });
  assert.equal(conf.level, 'low');
  assert.ok(conf.reasons.includes('NO_RESULTS'));
});

test('no keyword match reason when requested', () => {
  const results = [makeResult({ id: 'a', score: 0.9 })];
  const conf = computeConfidence({ results, keywordPresent: false });
  assert.ok(conf.reasons.includes('NO_KEYWORD_MATCH'));
});

test('one weak result yields low confidence', () => {
  const results = [makeResult({ id: 'a', score: 0.4 })];
  const conf = computeConfidence({ results });
  assert.equal(conf.level, 'low');
  assert.ok(conf.reasons.includes('TOO_FEW_RESULTS'));
});
