-- seed_usage_plans.sql
-- NOTE: replace the stripePriceId values with your REAL Stripe price IDs
-- before running in production.

BEGIN;

INSERT INTO "UsagePlan" (
  "id",
  "code",
  "name",
  "description",
  "monthlyTokens",
  "monthlyEmails",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "createdAt",
  "updatedAt"
) VALUES
  -- STARTER plan
  (
    gen_random_uuid(),
    'STARTER',
    'Starter',
    'For small projects and testing.',
    5000000,      -- monthlyInputTokens
    1000,       -- monthlyEmails
    2799,       -- €19.00
    'eur',
    'price_1SagU9GSx2QSwLkUo1XAOg5n',  -- TODO: replace with real Stripe price ID
    TRUE,
    NOW(),
    NOW()
  ),
  -- GROWTH plan
  (
    gen_random_uuid(),
    'GROWTH',
    'Growth',
    'For serious usage across multiple channels.',
    25000000,     -- monthlyInputTokens
    5000,
    8999,       -- €49.00
    'eur',
    'price_1SagWbGSx2QSwLkU0h6ZAYX5',   -- TODO: replace with real Stripe price ID
    TRUE,
    NOW(),
    NOW()
  ),
  -- SCALE plan
  (
    gen_random_uuid(),
    'SCALE',
    'Scale',
    'For high-volume bots in production.',
    110000000,    -- monthlyInputTokens
    20000,
    27999,      -- €129.00
    'eur',
    'price_1SagZ5GSx2QSwLkUvuDdr17o',    -- TODO: replace with real Stripe price ID
    TRUE,
    NOW(),
    NOW()
  ),
  -- CUSTOM plan (inactive, no Stripe price by default)
  (
    gen_random_uuid(),
    'CUSTOM',
    'Custom',
    'For custom limits and enterprise deals.',
    NULL,       -- monthlyInputTokens
    NULL,       -- monthlyEmails
    0,
    'eur',
    NULL,
    FALSE,
    NOW(),
    NOW()
  )
ON CONFLICT ("code") DO UPDATE
SET
  "name"                  = EXCLUDED."name",
  "description"           = EXCLUDED."description",
  "monthlyTokens"         = EXCLUDED."monthlyTokens",
  "monthlyEmails"         = EXCLUDED."monthlyEmails",
  "monthlyAmountCents"    = EXCLUDED."monthlyAmountCents",
  "currency"              = EXCLUDED."currency",
  "stripePriceId"         = EXCLUDED."stripePriceId",
  "isActive"              = EXCLUDED."isActive",
  "updatedAt"             = NOW();

COMMIT;
