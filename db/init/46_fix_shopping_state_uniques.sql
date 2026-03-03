-- Ensure unique constraints exist for Prisma upsert targets (idempotent)

-- Drop legacy partial indexes if they exist (they conflict with constraint names)
DROP INDEX IF EXISTS "ShoppingSessionState_bot_conversation_unique";
DROP INDEX IF EXISTS "ShoppingSessionState_bot_session_unique";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ShoppingSessionState_bot_conversation_unique'
  ) THEN
    ALTER TABLE "ShoppingSessionState"
      ADD CONSTRAINT "ShoppingSessionState_bot_conversation_unique"
      UNIQUE ("botId", "conversationId");
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ShoppingSessionState_bot_session_unique'
  ) THEN
    ALTER TABLE "ShoppingSessionState"
      ADD CONSTRAINT "ShoppingSessionState_bot_session_unique"
      UNIQUE ("botId", "sessionId");
  END IF;
END$$;
