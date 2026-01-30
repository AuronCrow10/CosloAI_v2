-- Add knowledge source enum + column (default RAG)
CREATE TYPE "KnowledgeSource" AS ENUM ('RAG', 'SHOPIFY');

ALTER TABLE "Bot"
ADD COLUMN "knowledgeSource" "KnowledgeSource" NOT NULL DEFAULT 'RAG';
