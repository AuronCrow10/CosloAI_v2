-- 2024-12-04: Collapse UsagePlan token limits into a single monthlyTokens column

ALTER TABLE "UsagePlan"
  DROP COLUMN IF EXISTS "monthlyTrainingTokens",
  DROP COLUMN IF EXISTS "monthlyInputTokens",
  DROP COLUMN IF EXISTS "monthlyOutputTokens";

ALTER TABLE "UsagePlan"
  ADD COLUMN IF NOT EXISTS "monthlyTokens" integer;
