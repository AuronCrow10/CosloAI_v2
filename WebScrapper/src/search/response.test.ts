import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResponse } from './service.js';
import { buildSearchHttpResponse } from './response.js';

const baseResponse: SearchResponse = {
  results: [],
  retrievalStatus: 'ok',
  noAnswerRecommended: false,
  confidence: { level: 'high', score: 0.9, reasons: [] },
};

test('default response includes operational signals and minimal confidence', () => {
  const payload = buildSearchHttpResponse({
    serviceResponse: baseResponse,
    returnDebug: false,
  });
  assert.deepEqual(payload.results, []);
  assert.equal(payload.retrievalStatus, 'ok');
  assert.equal(payload.noAnswerRecommended, false);
  assert.deepEqual(payload.confidence, { level: 'high', score: 0.9 });
  assert.equal('debug' in payload, false);
});

test('returnDebug=true includes debug payload', () => {
  const payload = buildSearchHttpResponse({
    serviceResponse: { ...baseResponse, debug: { strategy: 'vector', candidateCounts: { vector: 0, keyword: 0, merged: 0 } } },
    returnDebug: true,
  });
  assert.ok(payload.debug);
});

test('low confidence keeps results by default', () => {
  const payload = buildSearchHttpResponse({
    serviceResponse: {
      results: [{ id: 'a', clientId: 'c', domain: 'd', url: 'u', chunkIndex: 0, text: 't', score: 0.1, createdAt: new Date() }],
      retrievalStatus: 'low_confidence',
      noAnswerRecommended: true,
      confidence: { level: 'low', score: 0.2, reasons: ['LOW_TOP_SCORE'] },
    },
    returnDebug: false,
  });
  assert.equal(payload.results.length, 1);
  assert.equal(payload.retrievalStatus, 'low_confidence');
  assert.equal(payload.noAnswerRecommended, true);
  assert.deepEqual(payload.confidence, { level: 'low', score: 0.2 });
});

test('missing confidence yields safe fallback', () => {
  const payload = buildSearchHttpResponse({
    serviceResponse: { results: [] },
    returnDebug: false,
  });
  assert.deepEqual(payload.confidence, { level: 'low', score: 0 });
});
