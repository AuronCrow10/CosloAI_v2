BEGIN;

INSERT INTO "UsagePlan" (
  "id",
  "code",
  "name",
  "description",
  "monthlyTokens",
  "monthlyEmails",
  "monthlyWhatsappLeads",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "createdAt",
  "updatedAt"
) VALUES
  -- FREE plan
  (
    gen_random_uuid(),
    'FREE',
    'Free',
    'Get started with a limited free quota.',
    200000,        -- monthlyTokens (adjust as you like)
    20,            -- monthlyEmails (or NULL if not used)
    0,              -- monthlyWhatsappLeads (soft cap, adjust later)
    0,              -- €0.00
    'eur',
    'price_1SlnQBGSx2QSwLkUOFgLsD65',  -- TODO: replace with real Stripe price ID for the free plan
    TRUE,
    NOW(),
    NOW()
  ),
  -- STARTER plan
  (
    gen_random_uuid(),
    'STARTER',
    'Starter',
    'For small projects and testing.',
    5000000,        -- monthlyTokens
    300,           -- monthlyEmails
    50,              -- monthlyWhatsappLeads
    2799,           -- €27.99 (check your comment vs amount)
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
    25000000,       -- monthlyTokens
    1500,           -- monthlyEmails
    150,              -- monthlyWhatsappLeads
    8999,           -- €89.99
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
    110000000,      -- monthlyTokens
    10000,          -- monthlyEmails
    1000,              -- monthlyWhatsappLeads
    27999,          -- €279.99
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
    NULL,           -- monthlyTokens
    NULL,           -- monthlyEmails
    NULL,              -- monthlyWhatsappLeads (you can change to NULL if you prefer)
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
  "monthlyWhatsappLeads"  = EXCLUDED."monthlyWhatsappLeads",
  "monthlyAmountCents"    = EXCLUDED."monthlyAmountCents",
  "currency"              = EXCLUDED."currency",
  "stripePriceId"         = EXCLUDED."stripePriceId",
  "isActive"              = EXCLUDED."isActive",
  "updatedAt"             = NOW();

COMMIT;