import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../types.js';
import { buildAdjacentResults } from './adjacent.js';

function makeResult(params: Partial<SearchResult> & { id: string; score: number; chunkIndex: number; url: string }): SearchResult {
  return {
    id: params.id,
    clientId: params.clientId ?? 'client-1',
    domain: params.domain ?? 'example.com',
    url: params.url,
    sourceId: params.sourceId ?? null,
    chunkIndex: params.chunkIndex,
    text: params.text ?? `chunk-${params.chunkIndex}`,
    createdAt: params.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    score: params.score,
  };
}

test('includeAdjacent=false returns anchors unchanged', () => {
  const anchors = [makeResult({ id: 'a', score: 0.9, chunkIndex: 2, url: 'u' })];
  const { results } = buildAdjacentResults({
    anchors,
    chunkLookup: new Map(),
    options: { includeAdjacent: false, adjacentWindow: 1, stitchChunks: true },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
});

test('adjacent chunks are pulled only from same url and stitched in order', () => {
  const anchors = [
    makeResult({ id: 'a', score: 0.9, chunkIndex: 1, url: 'url-1', sourceId: 's1' }),
  ];
  const chunkLookup = new Map([
    [
      'source:s1',
      [
        makeResult({ id: 'c0', score: 0, chunkIndex: 0, url: 'url-1', text: 'alpha', sourceId: 's1' }),
        makeResult({ id: 'c1', score: 0, chunkIndex: 1, url: 'url-1', text: 'beta', sourceId: 's1' }),
        makeResult({ id: 'c2', score: 0, chunkIndex: 2, url: 'url-1', text: 'gamma', sourceId: 's1' }),
      ],
    ],
  ]);

  const { results } = buildAdjacentResults({
    anchors,
    chunkLookup,
    options: { includeAdjacent: true, adjacentWindow: 1, stitchChunks: true },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].anchorChunkId, 'a');
  assert.equal(results[0].chunkRangeStart, 0);
  assert.equal(results[0].chunkRangeEnd, 2);
  assert.ok(results[0].text.includes('alpha'));
  assert.ok(results[0].text.includes('beta'));
  assert.ok(results[0].text.includes('gamma'));
});

test('overlapping ranges are deduped by keeping first-ranked anchor', () => {
  const anchors = [
    makeResult({ id: 'a', score: 0.9, chunkIndex: 1, url: 'url-1', sourceId: 's1' }),
    makeResult({ id: 'b', score: 0.8, chunkIndex: 2, url: 'url-1', sourceId: 's1' }),
  ];
  const chunkLookup = new Map([
    [
      'source:s1',
      [
        makeResult({ id: 'c0', score: 0, chunkIndex: 0, url: 'url-1', sourceId: 's1' }),
        makeResult({ id: 'c1', score: 0, chunkIndex: 1, url: 'url-1', sourceId: 's1' }),
        makeResult({ id: 'c2', score: 0, chunkIndex: 2, url: 'url-1', sourceId: 's1' }),
        makeResult({ id: 'c3', score: 0, chunkIndex: 3, url: 'url-1', sourceId: 's1' }),
      ],
    ],
  ]);

  const { results } = buildAdjacentResults({
    anchors,
    chunkLookup,
    options: { includeAdjacent: true, adjacentWindow: 1, stitchChunks: true },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].anchorChunkId, 'a');
});

test('sourceId prevents mixing versions of the same url', () => {
  const anchors = [
    makeResult({ id: 'a', score: 0.9, chunkIndex: 1, url: 'url-1', sourceId: 's1' }),
  ];
  const chunkLookup = new Map([
    [
      'source:s1',
      [
        makeResult({ id: 'c1', score: 0, chunkIndex: 1, url: 'url-1', sourceId: 's1', text: 'v1' }),
      ],
    ],
    [
      'source:s2',
      [
        makeResult({ id: 'c2', score: 0, chunkIndex: 1, url: 'url-1', sourceId: 's2', text: 'v2' }),
      ],
    ],
  ]);

  const { results } = buildAdjacentResults({
    anchors,
    chunkLookup,
    options: { includeAdjacent: true, adjacentWindow: 0, stitchChunks: true },
  });

  assert.equal(results[0].text, 'v1');
});
