-- Ensure Prisma expected table exists (case-sensitive)
-- Safe to run multiple times.

-- 1) If a lowercase table exists, rename it.
ALTER TABLE IF EXISTS shopify_policy RENAME TO "ShopifyPolicy";

-- 2) Create the Prisma table if it doesn't exist.
CREATE TABLE IF NOT EXISTS "ShopifyPolicy" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  shop_id text NOT NULL REFERENCES "ShopifyShop"(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text,
  body text,
  url text,
  shopify_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_policy_shop_type_unique UNIQUE (shop_id, type)
);

-- 3) Ensure index exists.
CREATE INDEX IF NOT EXISTS shopify_policy_shop_id_idx
  ON "ShopifyPolicy" (shop_id);
