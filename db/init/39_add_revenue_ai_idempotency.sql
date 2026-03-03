-- Revenue AI action idempotency + session uplift indexes (idempotent)

ALTER TABLE "RevenueAIOfferAction"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "RevenueAIOfferAction_idempotencyKey_key"
  ON "RevenueAIOfferAction" ("idempotencyKey");

CREATE INDEX IF NOT EXISTS "RevenueAIOfferEvent_sessionId_idx"
  ON "RevenueAIOfferEvent" ("sessionId");

CREATE INDEX IF NOT EXISTS "shopify_analytics_event_session_id_idx"
  ON shopify_analytics_event (session_id);
