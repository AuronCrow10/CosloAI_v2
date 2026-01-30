-- Knowledge source enum + column (safe to run on existing DBs)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KnowledgeSource') THEN
    CREATE TYPE "KnowledgeSource" AS ENUM ('RAG', 'SHOPIFY');
  END IF;
END$$;

ALTER TABLE "Bot"
ADD COLUMN IF NOT EXISTS "knowledgeSource" "KnowledgeSource" NOT NULL DEFAULT 'RAG';

-- Optional: auto-switch bots that already have an active Shopify shop linked
-- UPDATE "Bot" b
-- SET "knowledgeSource" = 'SHOPIFY'
-- WHERE EXISTS (
--   SELECT 1
--   FROM "ShopifyShop" s
--   WHERE s."botId" = b."id" AND s."isActive" = true
-- );
