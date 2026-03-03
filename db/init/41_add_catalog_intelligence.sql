-- Catalog Intelligence schema + clerk state (idempotent)
CREATE TABLE IF NOT EXISTS "ShopCatalogSchema" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "schemaJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "ShopCatalogSchema_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopCatalogSchema_botId_shopDomain_unique"
  ON "ShopCatalogSchema" ("botId", "shopDomain");

CREATE INDEX IF NOT EXISTS "ShopCatalogSchema_botId_idx"
  ON "ShopCatalogSchema" ("botId");

CREATE INDEX IF NOT EXISTS "ShopCatalogSchema_shopDomain_idx"
  ON "ShopCatalogSchema" ("shopDomain");

CREATE TABLE IF NOT EXISTS "ShopifyClerkState" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "sessionId" TEXT,
  "conversationId" TEXT,
  "language" TEXT,
  "pendingQuestions" JSONB,
  "collectedFilters" JSONB,
  "lastShortlist" JSONB,
  "lastShortlistAt" TIMESTAMP,
  "selectedProductId" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "ShopifyClerkState_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopifyClerkState_botId_sessionId_unique"
  ON "ShopifyClerkState" ("botId", "sessionId");

CREATE UNIQUE INDEX IF NOT EXISTS "ShopifyClerkState_botId_conversationId_unique"
  ON "ShopifyClerkState" ("botId", "conversationId");

CREATE INDEX IF NOT EXISTS "ShopifyClerkState_botId_idx"
  ON "ShopifyClerkState" ("botId");

CREATE INDEX IF NOT EXISTS "ShopifyClerkState_sessionId_idx"
  ON "ShopifyClerkState" ("sessionId");

CREATE INDEX IF NOT EXISTS "ShopifyClerkState_conversationId_idx"
  ON "ShopifyClerkState" ("conversationId");

CREATE INDEX IF NOT EXISTS "ShopifyClerkState_updatedAt_idx"
  ON "ShopifyClerkState" ("updatedAt");
