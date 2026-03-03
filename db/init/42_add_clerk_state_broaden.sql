-- Add awaitingBroaden flag to clerk state (idempotent)
ALTER TABLE "ShopifyClerkState"
  ADD COLUMN IF NOT EXISTS "awaitingBroaden" BOOLEAN NOT NULL DEFAULT false;
