import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import { applyDedupeAndDiversity } from './selection.js';

function makeResult(params: Partial<SearchResult> & { id: string; score: number; url: string }): SearchResult {
  return {
    id: params.id,
    clientId: params.clientId ?? 'client-1',
    domain: params.domain ?? 'example.com',
    url: params.url,
    chunkIndex: params.chunkIndex ?? 0,
    text: params.text ?? 'sample',
    createdAt: params.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    score: params.score,
  };
}

test('exact duplicate removal', () => {
  const results = [
    makeResult({ id: 'a', score: 1, url: 'u1', text: 'Hello world' }),
    makeResult({ id: 'b', score: 0.9, url: 'u2', text: 'Hello world' }),
  ];
  const { results: out } = applyDedupeAndDiversity({
    results,
    options: { dedupeResults: true, diversifySources: false, finalLimit: 10 },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
});

test('near duplicate removal by overlap', () => {
  const results = [
    makeResult({ id: 'a', score: 1, url: 'u1', text: 'pricing plans include support and setup' }),
    makeResult({ id: 'b', score: 0.9, url: 'u2', text: 'pricing plans include support and setup plus extras' }),
  ];
  const { results: out } = applyDedupeAndDiversity({
    results,
    options: { dedupeResults: true, diversifySources: false, finalLimit: 10, nearDuplicateThreshold: 0.7 },
  });
  assert.equal(out.length, 1);
});

test('source cap enforced', () => {
  const results = [
    makeResult({ id: 'a', score: 1, url: 'u1' }),
    makeResult({ id: 'b', score: 0.9, url: 'u1' }),
    makeResult({ id: 'c', score: 0.8, url: 'u1' }),
    makeResult({ id: 'd', score: 0.7, url: 'u2' }),
  ];
  const { results: out } = applyDedupeAndDiversity({
    results,
    options: { dedupeResults: false, diversifySources: true, maxPerSource: 2, finalLimit: 10 },
  });
  const u1Count = out.filter((r) => r.url === 'u1').length;
  assert.equal(u1Count, 2);
});

test('diversity improves source spread', () => {
  const results = [
    makeResult({ id: 'a', score: 1, url: 'u1' }),
    makeResult({ id: 'b', score: 0.95, url: 'u1' }),
    makeResult({ id: 'c', score: 0.9, url: 'u2' }),
  ];
  const { results: out } = applyDedupeAndDiversity({
    results,
    options: { dedupeResults: false, diversifySources: true, maxPerSource: 1, finalLimit: 10 },
  });
  assert.equal(out.length, 2);
  assert.ok(out.some((r) => r.url === 'u1'));
  assert.ok(out.some((r) => r.url === 'u2'));
});

test('allow multiple high-score chunks from same source when cap allows', () => {
  const results = [
    makeResult({ id: 'a', score: 1, url: 'u1' }),
    makeResult({ id: 'b', score: 0.95, url: 'u1' }),
    makeResult({ id: 'c', score: 0.5, url: 'u2' }),
  ];
  const { results: out } = applyDedupeAndDiversity({
    results,
    options: { dedupeResults: false, diversifySources: true, maxPerSource: 2, finalLimit: 10 },
  });
  const u1Count = out.filter((r) => r.url === 'u1').length;
  assert.equal(u1Count, 2);
});
