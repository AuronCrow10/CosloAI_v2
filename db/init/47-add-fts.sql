\connect embeddings_db;

ALTER TABLE page_chunks_small
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

ALTER TABLE page_chunks_large
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

UPDATE page_chunks_small
SET search_tsv =
  setweight(to_tsvector('simple', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('simple', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('simple', COALESCE(domain, '')), 'C')
WHERE search_tsv IS NULL;

UPDATE page_chunks_large
SET search_tsv =
  setweight(to_tsvector('simple', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('simple', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('simple', COALESCE(domain, '')), 'C')
WHERE search_tsv IS NULL;

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_search_tsv
  ON page_chunks_small USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_search_tsv
  ON page_chunks_large USING GIN (search_tsv);
