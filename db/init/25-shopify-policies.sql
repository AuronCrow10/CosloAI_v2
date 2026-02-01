CREATE TABLE IF NOT EXISTS shopify_policy (
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

CREATE INDEX IF NOT EXISTS shopify_policy_shop_id_idx
  ON shopify_policy (shop_id);
