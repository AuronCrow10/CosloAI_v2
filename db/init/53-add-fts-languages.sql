\connect embeddings_db;

ALTER TABLE page_chunks_small
  ADD COLUMN IF NOT EXISTS search_tsv_en tsvector,
  ADD COLUMN IF NOT EXISTS search_tsv_it tsvector,
  ADD COLUMN IF NOT EXISTS search_tsv_es tsvector;

ALTER TABLE page_chunks_large
  ADD COLUMN IF NOT EXISTS search_tsv_en tsvector,
  ADD COLUMN IF NOT EXISTS search_tsv_it tsvector,
  ADD COLUMN IF NOT EXISTS search_tsv_es tsvector;

UPDATE page_chunks_small
SET search_tsv_en =
  setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(domain, '')), 'C')
WHERE search_tsv_en IS NULL;

UPDATE page_chunks_small
SET search_tsv_it =
  setweight(to_tsvector('italian', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(domain, '')), 'C')
WHERE search_tsv_it IS NULL;

UPDATE page_chunks_small
SET search_tsv_es =
  setweight(to_tsvector('spanish', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('spanish', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('spanish', COALESCE(domain, '')), 'C')
WHERE search_tsv_es IS NULL;

UPDATE page_chunks_large
SET search_tsv_en =
  setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(domain, '')), 'C')
WHERE search_tsv_en IS NULL;

UPDATE page_chunks_large
SET search_tsv_it =
  setweight(to_tsvector('italian', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('italian', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('italian', COALESCE(domain, '')), 'C')
WHERE search_tsv_it IS NULL;

UPDATE page_chunks_large
SET search_tsv_es =
  setweight(to_tsvector('spanish', COALESCE(chunk_text, '')), 'A') ||
  setweight(to_tsvector('spanish', COALESCE(url, '')), 'B') ||
  setweight(to_tsvector('spanish', COALESCE(domain, '')), 'C')
WHERE search_tsv_es IS NULL;

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_search_tsv_en
  ON page_chunks_small USING GIN (search_tsv_en);

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_search_tsv_it
  ON page_chunks_small USING GIN (search_tsv_it);

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_search_tsv_es
  ON page_chunks_small USING GIN (search_tsv_es);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_search_tsv_en
  ON page_chunks_large USING GIN (search_tsv_en);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_search_tsv_it
  ON page_chunks_large USING GIN (search_tsv_it);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_search_tsv_es
  ON page_chunks_large USING GIN (search_tsv_es);

CREATE OR REPLACE FUNCTION update_page_chunks_search_tsv()
RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', COALESCE(NEW.chunk_text, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.url, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.domain, '')), 'C');
  NEW.search_tsv_en :=
    setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.url, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.domain, '')), 'C');
  NEW.search_tsv_it :=
    setweight(to_tsvector('italian', COALESCE(NEW.chunk_text, '')), 'A') ||
    setweight(to_tsvector('italian', COALESCE(NEW.url, '')), 'B') ||
    setweight(to_tsvector('italian', COALESCE(NEW.domain, '')), 'C');
  NEW.search_tsv_es :=
    setweight(to_tsvector('spanish', COALESCE(NEW.chunk_text, '')), 'A') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.url, '')), 'B') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.domain, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_page_chunks_small_search_tsv ON page_chunks_small;
CREATE TRIGGER trg_page_chunks_small_search_tsv
BEFORE INSERT OR UPDATE OF chunk_text, url, domain ON page_chunks_small
FOR EACH ROW EXECUTE FUNCTION update_page_chunks_search_tsv();

DROP TRIGGER IF EXISTS trg_page_chunks_large_search_tsv ON page_chunks_large;
CREATE TRIGGER trg_page_chunks_large_search_tsv
BEFORE INSERT OR UPDATE OF chunk_text, url, domain ON page_chunks_large
FOR EACH ROW EXECUTE FUNCTION update_page_chunks_search_tsv();
