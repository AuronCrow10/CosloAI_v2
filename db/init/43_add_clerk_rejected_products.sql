-- Add rejectedProductIds to ShopifyClerkState
ALTER TABLE IF EXISTS "ShopifyClerkState"
  ADD COLUMN IF NOT EXISTS "rejectedProductIds" JSONB;
