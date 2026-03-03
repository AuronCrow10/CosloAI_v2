\connect embeddings_db;

ALTER TABLE page_chunks_small
  ADD COLUMN IF NOT EXISTS source_id UUID;

ALTER TABLE page_chunks_large
  ADD COLUMN IF NOT EXISTS source_id UUID;

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client_source_chunk_index
  ON page_chunks_small (client_id, source_id, chunk_index, is_active);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_client_source_chunk_index
  ON page_chunks_large (client_id, source_id, chunk_index);
