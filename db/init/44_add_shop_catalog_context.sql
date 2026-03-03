-- Create ShopCatalogContext table to store LLM-derived catalog summaries per shop/bot.
CREATE TABLE IF NOT EXISTS "ShopCatalogContext" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "contextJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopCatalogContext_botId_shopDomain_unique"
  ON "ShopCatalogContext" ("botId", "shopDomain");

CREATE INDEX IF NOT EXISTS "ShopCatalogContext_botId_idx"
  ON "ShopCatalogContext" ("botId");

CREATE INDEX IF NOT EXISTS "ShopCatalogContext_shopDomain_idx"
  ON "ShopCatalogContext" ("shopDomain");

ALTER TABLE "ShopCatalogContext"
  ADD CONSTRAINT "ShopCatalogContext_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "Bot" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
