CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "ShopifyShop" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopDomain" text NOT NULL UNIQUE,
  "accessTokenEncrypted" text NOT NULL,
  "storefrontAccessTokenEncrypted" text,
  "scopes" text NOT NULL,
  "installedAt" timestamptz NOT NULL DEFAULT now(),
  "uninstalledAt" timestamptz,
  "isActive" boolean NOT NULL DEFAULT true,
  "botId" text,
  "shopCurrency" text,
  "lastProductsSyncAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ShopifyShop_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "ShopifyShop_botId_idx" ON "ShopifyShop" ("botId");
CREATE INDEX IF NOT EXISTS "ShopifyShop_isActive_idx" ON "ShopifyShop" ("isActive");

CREATE TABLE IF NOT EXISTS "ShopifyProduct" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopId" text NOT NULL,
  "productId" text NOT NULL,
  "title" text NOT NULL,
  "handle" text,
  "bodyHtml" text,
  "vendor" text,
  "productType" text,
  "status" text,
  "tags" text[] NOT NULL DEFAULT '{}',
  "publishedAt" timestamptz,
  "shopifyCreatedAt" timestamptz,
  "shopifyUpdatedAt" timestamptz,
  "imageUrl" text,
  "priceMin" numeric(12, 2),
  "priceMax" numeric(12, 2),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "searchVector" tsvector,
  CONSTRAINT "ShopifyProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "ShopifyShop"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopifyProduct_shopId_productId_key" ON "ShopifyProduct" ("shopId", "productId");
CREATE INDEX IF NOT EXISTS "ShopifyProduct_shopId_idx" ON "ShopifyProduct" ("shopId");
CREATE INDEX IF NOT EXISTS "ShopifyProduct_status_idx" ON "ShopifyProduct" ("status");
CREATE INDEX IF NOT EXISTS "ShopifyProduct_searchVector_idx" ON "ShopifyProduct" USING GIN ("searchVector");

CREATE TABLE IF NOT EXISTS "ShopifyVariant" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopId" text NOT NULL,
  "productDbId" text NOT NULL,
  "variantId" text NOT NULL,
  "title" text,
  "sku" text,
  "price" numeric(12, 2),
  "compareAtPrice" numeric(12, 2),
  "availableForSale" boolean NOT NULL DEFAULT false,
  "inventoryQuantity" integer,
  "imageUrl" text,
  "selectedOptions" jsonb,
  "shopifyCreatedAt" timestamptz,
  "shopifyUpdatedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ShopifyVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "ShopifyShop"("id") ON DELETE CASCADE,
  CONSTRAINT "ShopifyVariant_productDbId_fkey" FOREIGN KEY ("productDbId") REFERENCES "ShopifyProduct"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopifyVariant_shopId_variantId_key" ON "ShopifyVariant" ("shopId", "variantId");
CREATE INDEX IF NOT EXISTS "ShopifyVariant_shopId_idx" ON "ShopifyVariant" ("shopId");
CREATE INDEX IF NOT EXISTS "ShopifyVariant_productDbId_idx" ON "ShopifyVariant" ("productDbId");

CREATE OR REPLACE FUNCTION shopify_products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    to_tsvector(
      'simple',
      coalesce(NEW."title", '') || ' ' ||
      coalesce(NEW."bodyHtml", '') || ' ' ||
      coalesce(NEW."vendor", '') || ' ' ||
      coalesce(NEW."productType", '') || ' ' ||
      array_to_string(NEW."tags", ' ')
    );
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ShopifyProduct_search_vector_trg" ON "ShopifyProduct";
CREATE TRIGGER "ShopifyProduct_search_vector_trg"
BEFORE INSERT OR UPDATE ON "ShopifyProduct"
FOR EACH ROW EXECUTE PROCEDURE shopify_products_search_vector_update();
