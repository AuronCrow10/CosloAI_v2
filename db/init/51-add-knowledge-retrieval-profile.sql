-- Knowledge retrieval profile (bot setting)
-- NOTE: run in the "chatbot" DB

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'KnowledgeRetrievalProfile'
  ) THEN
    CREATE TYPE "KnowledgeRetrievalProfile" AS ENUM ('balanced', 'precise', 'broad');
  END IF;
END $$;

ALTER TABLE "Bot"
ADD COLUMN IF NOT EXISTS "knowledgeRetrievalProfile" "KnowledgeRetrievalProfile" NOT NULL DEFAULT 'balanced';
