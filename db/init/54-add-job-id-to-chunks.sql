-- Manual script: add job_id to chunk tables and backfill from source_id.
-- Run against embeddings_db.

\connect embeddings_db;

-- 1) Add job_id columns (nullable for legacy data).
ALTER TABLE page_chunks_small
  ADD COLUMN IF NOT EXISTS job_id UUID;

ALTER TABLE page_chunks_large
  ADD COLUMN IF NOT EXISTS job_id UUID;

-- 2) Index for faster job-scoped lookups.
CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client_job
  ON page_chunks_small (client_id, job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_client_job
  ON page_chunks_large (client_id, job_id)
  WHERE job_id IS NOT NULL;

-- 3) Helper functions to recompute source_id (MD5 -> UUID) like app code.
CREATE OR REPLACE FUNCTION normalize_url_for_source(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s text;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- Strip fragment (#...)
  s := split_part(raw, '#', 1);

  -- Trim trailing slash (except root)
  IF length(s) > 1 AND right(s, 1) = '/' THEN
    s := left(s, length(s) - 1);
  END IF;

  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION deterministic_uuid(input text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    substr(md5(input), 1, 8) || '-' ||
    substr(md5(input), 9, 4) || '-' ||
    substr(md5(input), 13, 4) || '-' ||
    substr(md5(input), 17, 4) || '-' ||
    substr(md5(input), 21, 12)
  )::uuid;
$$;

-- 4) Backfill job_id where source_id is present.
-- This matches buildSourceId(clientId|jobId|normalizedUrl) from app code.
UPDATE page_chunks_small c
SET job_id = j.id
FROM crawl_jobs j
WHERE c.job_id IS NULL
  AND c.source_id IS NOT NULL
  AND c.client_id = j.client_id
  AND c.source_id = deterministic_uuid(
    j.client_id::text || '|' || j.id::text || '|' || normalize_url_for_source(c.url)
  );

UPDATE page_chunks_large c
SET job_id = j.id
FROM crawl_jobs j
WHERE c.job_id IS NULL
  AND c.source_id IS NOT NULL
  AND c.client_id = j.client_id
  AND c.source_id = deterministic_uuid(
    j.client_id::text || '|' || j.id::text || '|' || normalize_url_for_source(c.url)
  );

-- 5) Optional verification queries:
-- SELECT COUNT(*) AS with_job_id_small FROM page_chunks_small WHERE job_id IS NOT NULL;
-- SELECT COUNT(*) AS with_job_id_large FROM page_chunks_large WHERE job_id IS NOT NULL;
-- SELECT job_id, COUNT(*) FROM page_chunks_small WHERE job_id IS NOT NULL GROUP BY job_id ORDER BY COUNT(*) DESC;
