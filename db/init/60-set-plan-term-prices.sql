BEGIN;

-- Fill this table with your real discounted term totals and Stripe price IDs.
-- Leave NULL to keep current value unchanged.
--
-- Amounts are TOTAL billed for the whole term, in cents:
-- - semi_annual_amount_cents = 6-month total
-- - annual_amount_cents      = 12-month total
--
-- Example:
-- ('STARTER', 21594, 39588, 'price_xxx_6m_starter', 'price_xxx_12m_starter')

WITH term_updates (
  code,
  semi_annual_amount_cents,
  annual_amount_cents,
  stripe_semi_annual_price_id,
  stripe_annual_price_id
) AS (
  VALUES
    ('STARTER', 21595, 38390, 'price_1T8dCnGSx2QSwLkUTXJcE6HI', 'price_1T8dHuGSx2QSwLkUMHknquex'),
    ('GROWTH',  70195, 124790, 'price_1T8dO6GSx2QSwLkU2Wsl1VsE', 'price_1T8dOfGSx2QSwLkUTCuZYoO3'),
    ('SCALE',   215995, 383990, 'price_1T8dQlGSx2QSwLkURblnrgv4', 'price_1T8dR8GSx2QSwLkUyzsGKC3D')
)
UPDATE "UsagePlan" p
SET
  "semiAnnualAmountCents"   = COALESCE(t.semi_annual_amount_cents, p."semiAnnualAmountCents"),
  "annualAmountCents"       = COALESCE(t.annual_amount_cents, p."annualAmountCents"),
  "stripeSemiAnnualPriceId" = COALESCE(t.stripe_semi_annual_price_id, p."stripeSemiAnnualPriceId"),
  "stripeAnnualPriceId"     = COALESCE(t.stripe_annual_price_id, p."stripeAnnualPriceId"),
  "updatedAt"               = NOW()
FROM term_updates t
WHERE p."code" = t.code;

COMMIT;

