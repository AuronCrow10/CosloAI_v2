-- Revenue AI core tables + bot settings (idempotent)

-- Bot settings columns
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIMode" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIOfferEveryXMessages" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIMaxOffersPerSession" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAICooldownMinutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIDedupeHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIAttributionWindowHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "revenueAIGuardrailsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Revenue AI session state per conversation
CREATE TABLE IF NOT EXISTS "RevenueAISession" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "assignedStyle" TEXT NOT NULL,
  "styleOverride" TEXT,
  "offersShownCount" INTEGER NOT NULL DEFAULT 0,
  "lastOfferMessageIndex" INTEGER,
  "lastOfferAt" TIMESTAMP(3),
  "lastSuggestedProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastSuggestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueAISession_pkey" PRIMARY KEY ("id")
);

-- Revenue AI offer impressions (immutable)
CREATE TABLE IF NOT EXISTS "RevenueAIOfferEvent" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT,
  "sessionId" TEXT,
  "offerType" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "suggestedProductId" TEXT NOT NULL,
  "baseProductId" TEXT,
  "styleUsed" TEXT NOT NULL,
  "meta" JSONB,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueAIOfferEvent_pkey" PRIMARY KEY ("id")
);

-- Revenue AI CTA/action tracking
CREATE TABLE IF NOT EXISTS "RevenueAIOfferAction" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "orderId" TEXT,
  "revenueCents" INTEGER,
  "currency" TEXT,
  "meta" JSONB,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueAIOfferAction_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "RevenueAISession_conversationId_key"
  ON "RevenueAISession" ("conversationId");
CREATE INDEX IF NOT EXISTS "RevenueAISession_botId_idx"
  ON "RevenueAISession" ("botId");
CREATE INDEX IF NOT EXISTS "RevenueAISession_updatedAt_idx"
  ON "RevenueAISession" ("updatedAt");

CREATE INDEX IF NOT EXISTS "RevenueAIOfferEvent_botId_idx"
  ON "RevenueAIOfferEvent" ("botId");
CREATE INDEX IF NOT EXISTS "RevenueAIOfferEvent_timestamp_idx"
  ON "RevenueAIOfferEvent" ("timestamp");
CREATE INDEX IF NOT EXISTS "RevenueAIOfferEvent_conversationId_idx"
  ON "RevenueAIOfferEvent" ("conversationId");
CREATE INDEX IF NOT EXISTS "RevenueAIOfferEvent_offerType_idx"
  ON "RevenueAIOfferEvent" ("offerType");

CREATE INDEX IF NOT EXISTS "RevenueAIOfferAction_botId_idx"
  ON "RevenueAIOfferAction" ("botId");
CREATE INDEX IF NOT EXISTS "RevenueAIOfferAction_timestamp_idx"
  ON "RevenueAIOfferAction" ("timestamp");
CREATE INDEX IF NOT EXISTS "RevenueAIOfferAction_action_idx"
  ON "RevenueAIOfferAction" ("action");
CREATE INDEX IF NOT EXISTS "RevenueAIOfferAction_eventId_idx"
  ON "RevenueAIOfferAction" ("eventId");

-- Foreign keys (idempotent)
DO $$
BEGIN
  ALTER TABLE "RevenueAISession"
    ADD CONSTRAINT "RevenueAISession_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAISession"
    ADD CONSTRAINT "RevenueAISession_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferEvent"
    ADD CONSTRAINT "RevenueAIOfferEvent_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferEvent"
    ADD CONSTRAINT "RevenueAIOfferEvent_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferEvent"
    ADD CONSTRAINT "RevenueAIOfferEvent_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferEvent"
    ADD CONSTRAINT "RevenueAIOfferEvent_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "RevenueAISession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferAction"
    ADD CONSTRAINT "RevenueAIOfferAction_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "RevenueAIOfferEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferAction"
    ADD CONSTRAINT "RevenueAIOfferAction_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIOfferAction"
    ADD CONSTRAINT "RevenueAIOfferAction_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
