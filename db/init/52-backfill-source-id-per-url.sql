\connect embeddings_db;

-- Backfill source_id so each URL within a job gets its own source unit.
-- Only update source_id values that currently map to multiple URLs.

WITH multi AS (
  SELECT source_id
  FROM page_chunks_small
  WHERE source_id IS NOT NULL
  GROUP BY source_id
  HAVING COUNT(DISTINCT url) > 1
)
UPDATE page_chunks_small p
SET source_id = (
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 1 for 8) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 9 for 4) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 13 for 4) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 17 for 4) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 21 for 12)
)::uuid
WHERE p.source_id IN (SELECT source_id FROM multi)
  AND p.url IS NOT NULL;

WITH multi AS (
  SELECT source_id
  FROM page_chunks_large
  WHERE source_id IS NOT NULL
  GROUP BY source_id
  HAVING COUNT(DISTINCT url) > 1
)
UPDATE page_chunks_large p
SET source_id = (
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 1 for 8) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 9 for 4) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 13 for 4) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 17 for 4) || '-' ||
  substring(md5(
    p.client_id::text || '|' ||
    p.source_id::text || '|' ||
    regexp_replace(regexp_replace(p.url, '#.*$', ''), '/+$', '')
  ) from 21 for 12)
)::uuid
WHERE p.source_id IN (SELECT source_id FROM multi)
  AND p.url IS NOT NULL;
