ALTER TABLE page_chunks_small
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client_domain_active
  ON page_chunks_small (client_id, domain, is_active);

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client_url_active
  ON page_chunks_small (client_id, url, is_active);
