\connect embeddings_db;

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client_url_chunk_index
  ON page_chunks_small (client_id, url, chunk_index, is_active);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_client_url_chunk_index
  ON page_chunks_large (client_id, url, chunk_index);
