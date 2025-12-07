\connect embeddings_db;

CREATE TABLE IF NOT EXISTS client_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    model TEXT NOT NULL CHECK (
      model IN ('text-embedding-3-small', 'text-embedding-3-large')
    ),
    operation TEXT NOT NULL,
    prompt_tokens BIGINT NOT NULL,
    total_tokens BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_usage_client_created
  ON client_usage (client_id, created_at);