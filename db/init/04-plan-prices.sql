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
    200000,        -- monthlyTokens (≈ up to 150 messages OR 100 pages)
    20,            -- monthlyEmails
    0,             -- monthlyWhatsappLeads (WhatsApp template messages)
    0,             -- €0.00
    'eur',
    'price_1SpAepGSx2QSwLkU8pQSFAZp',  -- TODO: replace with real Stripe price ID for the free plan (if you use one)
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
    6000000,       -- monthlyTokens (6M)
    1000,          -- monthlyEmails
    200,           -- monthlyWhatsappLeads (WhatsApp template messages)
    2999,          -- €29.99
    'eur',
    'price_1SpAfxGSx2QSwLkUDwarmw6z',  -- TODO: replace with real Stripe price ID for €29.99
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
    30000000,      -- monthlyTokens (30M)
    5000,          -- monthlyEmails
    1000,          -- monthlyWhatsappLeads (WhatsApp template messages)
    9999,          -- €99.99
    'eur',
    'price_1SpAghGSx2QSwLkU2wO3ZiLY',   -- TODO: replace with real Stripe price ID for €99.99
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
    130000000,     -- monthlyTokens (130M)
    20000,         -- monthlyEmails
    5000,          -- monthlyWhatsappLeads (WhatsApp template messages)
    29999,         -- €299.99
    'eur',
    'price_1SpAhEGSx2QSwLkUXAi3Ckl1',    -- TODO: replace with real Stripe price ID for €299.99
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
    NULL,          -- monthlyTokens
    NULL,          -- monthlyEmails
    NULL,          -- monthlyWhatsappLeads
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
