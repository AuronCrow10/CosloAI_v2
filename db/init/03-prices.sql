\connect chatbot

-- Make sure UUID generator exists (safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CALENDAR
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'CALENDAR',
  'Calendar bookings',
  3999,
  'eur',
  'price_1SXghFGSx2QSwLkUdIqAfTyU',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- INSTAGRAM
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'INSTAGRAM',
  'Instagram channel',
  2999,
  'eur',
  'price_1SXggfGSx2QSwLkUHrWXuSqe',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- MESSENGER
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'MESSENGER',
  'Facebook Messenger channel',
  2999,
  'eur',
  'price_1SXgg1GSx2QSwLkU22wqZ3ag',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- WHATSAPP
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'WHATSAPP',
  'WhatsApp channel',
  2999,
  'eur',
  'price_1SXgfMGSx2QSwLkU2Hzk1ges',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- CHANNEL_WEB
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'CHANNEL_WEB',
  'Web channel / widget',
  1999,
  'eur',
  'price_1SXgeHGSx2QSwLkUBjNFF4th',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- PDF_CRAWLER
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'PDF_CRAWLER',
  'PDF / document crawler',
  999,
  'eur',
  'price_1SXgdXGSx2QSwLkU3mpgopPJ',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- DOMAIN_CRAWLER
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'DOMAIN_CRAWLER',
  'Domain crawler',
  2999,
  'eur',
  'price_1SXgcyGSx2QSwLkUQoJlHROP',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- LEAD_WHATSAPP_200
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'LEAD_WHATSAPP_200',
  'Lead Ads → WhatsApp (200 messages)',
  1000,
  'eur',
  'price_1SiZ6oGSx2QSwLkUXNZZYKC9',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- LEAD_WHATSAPP_500
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'LEAD_WHATSAPP_500',
  'Lead Ads → WhatsApp (500 messages)',
  2000,
  'eur',
  'price_1SiZ7RGSx2QSwLkUSH51y2KS',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

-- LEAD_WHATSAPP_1000
INSERT INTO "FeaturePrice" (
  "id",
  "code",
  "label",
  "monthlyAmountCents",
  "currency",
  "stripePriceId",
  "isActive",
  "updatedAt"
)
VALUES (
  uuid_generate_v4(),
  'LEAD_WHATSAPP_1000',
  'Lead Ads → WhatsApp (1000 messages)',
  3000,
  'eur',
  'price_1SiZ7gGSx2QSwLkUpp9vpHKw',
  TRUE,
  now()
)
ON CONFLICT ("code") DO UPDATE
SET "label"              = EXCLUDED."label",
    "monthlyAmountCents" = EXCLUDED."monthlyAmountCents",
    "currency"           = EXCLUDED."currency",
    "stripePriceId"      = EXCLUDED."stripePriceId",
    "isActive"           = EXCLUDED."isActive",
    "updatedAt"          = now();

COMMIT;
