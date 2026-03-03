-- Revenue AI recommender config (idempotent)
ALTER TABLE "Bot"
  ADD COLUMN IF NOT EXISTS "revenueAIUpsellDeltaMinPct" INTEGER DEFAULT 10;

ALTER TABLE "Bot"
  ADD COLUMN IF NOT EXISTS "revenueAIUpsellDeltaMaxPct" INTEGER DEFAULT 35;

ALTER TABLE "Bot"
  ADD COLUMN IF NOT EXISTS "revenueAIMaxRecommendations" INTEGER DEFAULT 3;

ALTER TABLE "Bot"
  ADD COLUMN IF NOT EXISTS "revenueAIAggressiveness" DOUBLE PRECISION DEFAULT 0.5;

ALTER TABLE "Bot"
  ADD COLUMN IF NOT EXISTS "revenueAICategoryComplementMap" JSONB;
