\connect embeddings_db;

CREATE OR REPLACE FUNCTION update_page_chunks_search_tsv()
RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', COALESCE(NEW.chunk_text, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.url, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(NEW.domain, '')), 'C');
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
