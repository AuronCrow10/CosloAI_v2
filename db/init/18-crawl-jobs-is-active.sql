ALTER TABLE crawl_jobs
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_client_active
  ON crawl_jobs (client_id, is_active);
