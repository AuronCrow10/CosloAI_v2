\connect embeddings_db;

-- Create table (fresh installs)
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  domain TEXT NOT NULL,
  start_url TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),

  -- NEW: what kind of ingestion this row represents
  job_type TEXT NOT NULL DEFAULT 'domain' CHECK (job_type IN ('domain','docs')),

  -- If sitemap is available we set this to a real-ish number; otherwise use maxPages as estimate
  total_pages_estimated INT,

  pages_visited INT NOT NULL DEFAULT 0,
  pages_stored  INT NOT NULL DEFAULT 0,
  chunks_stored INT NOT NULL DEFAULT 0,

  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent upgrade for existing installs
ALTER TABLE crawl_jobs
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'domain';

DO $$
BEGIN
  -- Ensure constraint exists (Postgres doesn't support IF NOT EXISTS on ADD CONSTRAINT)
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'crawl_jobs_job_type_chk'
  ) THEN
    ALTER TABLE crawl_jobs
      ADD CONSTRAINT crawl_jobs_job_type_chk
      CHECK (job_type IN ('domain','docs'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_client_created
  ON crawl_jobs (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status
  ON crawl_jobs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_type_created
  ON crawl_jobs (job_type, created_at DESC);
