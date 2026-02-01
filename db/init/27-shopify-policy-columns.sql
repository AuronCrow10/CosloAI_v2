-- Fix column names to match Prisma model (camelCase)
-- Safe to run multiple times.

-- Rename snake_case -> camelCase if present
ALTER TABLE IF EXISTS "ShopifyPolicy" RENAME COLUMN IF EXISTS shop_id TO "shopId";
ALTER TABLE IF EXISTS "ShopifyPolicy" RENAME COLUMN IF EXISTS shopify_updated_at TO "shopifyUpdatedAt";
ALTER TABLE IF EXISTS "ShopifyPolicy" RENAME COLUMN IF EXISTS created_at TO "createdAt";
ALTER TABLE IF EXISTS "ShopifyPolicy" RENAME COLUMN IF EXISTS updated_at TO "updatedAt";

-- Ensure indexes/constraints exist with correct column names
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shopify_policy_shop_type_unique'
  ) THEN
    ALTER TABLE "ShopifyPolicy"
      ADD CONSTRAINT shopify_policy_shop_type_unique UNIQUE ("shopId", type);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS shopify_policy_shop_id_idx
  ON "ShopifyPolicy" ("shopId");
