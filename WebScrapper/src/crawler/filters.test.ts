import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipCrawlUrl } from './filters.js';

test('skips xml endpoints', () => {
  assert.equal(shouldSkipCrawlUrl('https://example.com/sitemap.xml'), true);
  assert.equal(shouldSkipCrawlUrl('https://example.com/feed.xml?page=2'), true);
});

test('skips sitemap-like paths even without .xml extension', () => {
  assert.equal(shouldSkipCrawlUrl('https://example.com/sitemap'), true);
  assert.equal(shouldSkipCrawlUrl('https://example.com/blog/sitemap_index'), true);
  assert.equal(shouldSkipCrawlUrl('https://example.com/wp-sitemap-posts-post-1'), true);
});

test('keeps normal html pages crawlable', () => {
  assert.equal(shouldSkipCrawlUrl('https://example.com/'), false);
  assert.equal(shouldSkipCrawlUrl('https://example.com/pricing'), false);
  assert.equal(shouldSkipCrawlUrl('https://example.com/contact?ref=home'), false);
});
