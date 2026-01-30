CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "ShopifyDataEvent" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopId" text,
  "shopDomain" text,
  "customerEmail" text,
  "eventType" text NOT NULL,
  "webhookId" text,
  "payloadJson" jsonb,
  "processedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ShopifyDataEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "ShopifyShop"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "ShopifyDataEvent_shopId_idx" ON "ShopifyDataEvent" ("shopId");
CREATE INDEX IF NOT EXISTS "ShopifyDataEvent_shopDomain_idx" ON "ShopifyDataEvent" ("shopDomain");
CREATE INDEX IF NOT EXISTS "ShopifyDataEvent_eventType_idx" ON "ShopifyDataEvent" ("eventType");
CREATE UNIQUE INDEX IF NOT EXISTS "ShopifyDataEvent_webhookId_key" ON "ShopifyDataEvent" ("webhookId");
