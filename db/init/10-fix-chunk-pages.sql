\connect embeddings_db;

-- For SMALL embeddings
ALTER TABLE page_chunks_small
  ADD CONSTRAINT page_chunks_small_chunk_hash_unique
  UNIQUE (client_id, chunk_hash);

-- For LARGE embeddings
ALTER TABLE page_chunks_large
  ADD CONSTRAINT page_chunks_large_chunk_hash_unique
  UNIQUE (client_id, chunk_hash);

  