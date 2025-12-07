\connect embeddings_db;

-- Constraints on page_chunks_small
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'page_chunks_small'::regclass;

-- Indexes on page_chunks_small
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'page_chunks_small';
