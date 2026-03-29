BEGIN;

ALTER TABLE "UsagePlan"
  ADD COLUMN IF NOT EXISTS "semiAnnualAmountCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "annualAmountCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "stripeSemiAnnualPriceId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeAnnualPriceId" TEXT;

ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "billingTerm" TEXT NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN IF NOT EXISTS "usageAnchorAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pendingUsagePlanId" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingBillingTerm" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingSwitchAt" TIMESTAMP(3);

UPDATE "UsagePlan"
SET "semiAnnualAmountCents" = "monthlyAmountCents" * 6
WHERE "semiAnnualAmountCents" IS NULL
  AND "monthlyAmountCents" IS NOT NULL;

UPDATE "UsagePlan"
SET "annualAmountCents" = "monthlyAmountCents" * 12
WHERE "annualAmountCents" IS NULL
  AND "monthlyAmountCents" IS NOT NULL;

UPDATE "Subscription"
SET "usageAnchorAt" = COALESCE("usageAnchorAt", "createdAt")
WHERE "usageAnchorAt" IS NULL;

COMMIT;
