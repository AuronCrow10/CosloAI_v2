-- Attach existing users to a referral code (manual backfill)
-- Safe: only updates users in the provided email list.
-- Set referredAt only if it is null.

BEGIN;

-- 1) Resolve the referral code
WITH code AS (
  SELECT id
  FROM "ReferralCode"
  WHERE code = 'J9HCGX86FS'
  LIMIT 1
)
-- 2) Update matching users
UPDATE "User" u
SET
  "referralCodeId" = (SELECT id FROM code),
  "referredAt" = COALESCE(u."referredAt", NOW())
WHERE
  (SELECT id FROM code) IS NOT NULL
  AND LOWER(u.email) IN (
    'flow.strategia@gmail.com',
    'frasorrenti1968@gmail.com',
    'carlo.campinoti01@gmail.com',
    'ilaria.dutto@gmail.com',
    'alessandro.villa@villa-consulting.it'
  );

-- Optional: review the affected users
-- SELECT id, email, "referralCodeId", "referredAt" FROM "User"
-- WHERE LOWER(email) IN (
--   'flow.strategia@gmail.com',
--   'frasorrenti1968@gmail.com',
--   'carlo.campinoti01@gmail.com',
--   'ilaria.dutto@gmail.com',
--   'alessandro.villa@villa-consulting.it'
-- );

COMMIT;
