-- Shopify analytics events (view product, add to cart, purchases)
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS shopify_analytics_event (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shop_domain TEXT NOT NULL,
  bot_id TEXT,
  event_type TEXT NOT NULL,
  session_id TEXT,
  conversation_id TEXT,
  product_id TEXT,
  variant_id TEXT,
  order_id TEXT,
  order_name TEXT,
  order_number TEXT,
  revenue_cents INTEGER,
  currency TEXT,
  source TEXT,
  meta JSONB
);

CREATE INDEX IF NOT EXISTS shopify_analytics_event_shop_created_idx
  ON shopify_analytics_event (shop_domain, created_at DESC);

CREATE INDEX IF NOT EXISTS shopify_analytics_event_bot_created_idx
  ON shopify_analytics_event (bot_id, created_at DESC);

CREATE INDEX IF NOT EXISTS shopify_analytics_event_type_created_idx
  ON shopify_analytics_event (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS shopify_analytics_event_order_idx
  ON shopify_analytics_event (order_id);
