\connect embeddings_db;

CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    embedding_model TEXT NOT NULL CHECK (
      embedding_model IN ('text-embedding-3-small', 'text-embedding-3-large')
    ),
    main_domain TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_name ON clients (name);

-- Chunks table for text-embedding-3-small (1536 dims)

CREATE TABLE IF NOT EXISTS page_chunks_small (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    url TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    embedding vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Global uniqueness by chunk_hash (dedup per table/model)
ALTER TABLE page_chunks_small
  ADD CONSTRAINT page_chunks_small_chunk_hash_unique
  UNIQUE (chunk_hash);

CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client ON page_chunks_small (client_id);
CREATE INDEX IF NOT EXISTS idx_page_chunks_small_client_domain ON page_chunks_small (client_id, domain);
CREATE INDEX IF NOT EXISTS idx_page_chunks_small_chunk_hash ON page_chunks_small (chunk_hash);

-- Vector index for similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_page_chunks_small_embedding_ivfflat
ON page_chunks_small
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Chunks table for text-embedding-3-large (3072 dims)
-- Requires pgvector >= 0.7.0 for halfvec indexing.

CREATE TABLE IF NOT EXISTS page_chunks_large (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    url TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    -- Store full-precision vectors
    embedding vector(3072) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Global uniqueness by chunk_hash (dedup per table/model)
ALTER TABLE page_chunks_large
  ADD CONSTRAINT page_chunks_large_chunk_hash_unique
  UNIQUE (chunk_hash);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_client
  ON page_chunks_large (client_id);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_client_domain
  ON page_chunks_large (client_id, domain);

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_chunk_hash
  ON page_chunks_large (chunk_hash);

-- IMPORTANT: we cannot index vector(3072) directly with ivfflat/hnsw because
-- pgvector limits indexable "vector" dimensions to <= 2000.
-- Instead, index an expression that casts to halfvec(3072), which allows
-- up to 4000 dimensions.

CREATE INDEX IF NOT EXISTS idx_page_chunks_large_embedding_hnsw
ON page_chunks_large
USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
