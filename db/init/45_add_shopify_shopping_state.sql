-- Create shopping session state table for conversational Shopify assistant
-- Idempotent where possible.

-- Ensure UUID generator exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS "ShoppingSessionState" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "botId" uuid NOT NULL,
  "conversationId" uuid NULL,
  "sessionId" text NULL,
  "stateJson" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Uniqueness: one state per bot + conversation/session
CREATE UNIQUE INDEX IF NOT EXISTS "ShoppingSessionState_bot_conversation_unique"
  ON "ShoppingSessionState" ("botId", "conversationId")
  WHERE "conversationId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ShoppingSessionState_bot_session_unique"
  ON "ShoppingSessionState" ("botId", "sessionId")
  WHERE "sessionId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ShoppingSessionState_bot_idx"
  ON "ShoppingSessionState" ("botId");

CREATE INDEX IF NOT EXISTS "ShoppingSessionState_conversation_idx"
  ON "ShoppingSessionState" ("conversationId");

CREATE INDEX IF NOT EXISTS "ShoppingSessionState_session_idx"
  ON "ShoppingSessionState" ("sessionId");
