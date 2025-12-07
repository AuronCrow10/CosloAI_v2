\connect embeddings_db;

-- 1) SAFETY CHECKS (optional but nice for visibility)
-- Check for duplicates per (client_id, chunk_hash).
-- If this returns any rows, you may want to inspect before enforcing uniqueness.
SELECT client_id, chunk_hash, COUNT(*) AS cnt
FROM page_chunks_small
GROUP BY client_id, chunk_hash
HAVING COUNT(*) > 1;

SELECT client_id, chunk_hash, COUNT(*) AS cnt
FROM page_chunks_large
GROUP BY client_id, chunk_hash
HAVING COUNT(*) > 1;

-- 2) SMALL TABLE: drop old global unique + index, add per-client unique

DO $$
BEGIN
  -- Drop the old global unique constraint on chunk_hash if it exists
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'page_chunks_small_chunk_hash_unique'
  ) THEN
    ALTER TABLE page_chunks_small
      DROP CONSTRAINT page_chunks_small_chunk_hash_unique;
  END IF;
END;
$$;

-- Drop the old plain index on chunk_hash (the new unique constraint will cover it)
DROP INDEX IF EXISTS idx_page_chunks_small_chunk_hash;

-- Add the new per-client unique constraint
ALTER TABLE page_chunks_small
  ADD CONSTRAINT page_chunks_small_client_chunk_hash_unique
  UNIQUE (client_id, chunk_hash);


-- 3) LARGE TABLE: same idea

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'page_chunks_large_chunk_hash_unique'
  ) THEN
    ALTER TABLE page_chunks_large
      DROP CONSTRAINT page_chunks_large_chunk_hash_unique;
  END IF;
END;
$$;

DROP INDEX IF EXISTS idx_page_chunks_large_chunk_hash;

ALTER TABLE page_chunks_large
  ADD CONSTRAINT page_chunks_large_client_chunk_hash_unique
  UNIQUE (client_id, chunk_hash);
