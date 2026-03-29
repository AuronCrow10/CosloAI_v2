-- Add knowledge retrieval profile enum + column (default balanced)
CREATE TYPE "KnowledgeRetrievalProfile" AS ENUM ('balanced', 'precise', 'broad');

ALTER TABLE "Bot"
ADD COLUMN "knowledgeRetrievalProfile" "KnowledgeRetrievalProfile" NOT NULL DEFAULT 'balanced';
