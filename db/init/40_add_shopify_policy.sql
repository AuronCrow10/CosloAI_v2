-- Create ShopifyPolicy table (idempotent)
CREATE TABLE IF NOT EXISTS "ShopifyPolicy" (
  "id" TEXT PRIMARY KEY,
  "shopId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT,
  "body" TEXT,
  "url" TEXT,
  "shopifyUpdatedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "ShopifyPolicy_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "ShopifyShop"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopifyPolicy_shopId_type"
  ON "ShopifyPolicy" ("shopId", "type");

CREATE INDEX IF NOT EXISTS "ShopifyPolicy_shopId_idx"
  ON "ShopifyPolicy" ("shopId");
