-- Revenue AI style override + audit log (idempotent)

CREATE TABLE IF NOT EXISTS "RevenueAIStyleOverride" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "conversationId" TEXT,
  "sessionId" TEXT,
  "styleOverride" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueAIStyleOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RevenueAIStyleOverrideAudit" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "conversationId" TEXT,
  "sessionId" TEXT,
  "fromStyle" TEXT,
  "toStyle" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueAIStyleOverrideAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverride_botId_idx"
  ON "RevenueAIStyleOverride" ("botId");
CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverride_conversationId_idx"
  ON "RevenueAIStyleOverride" ("conversationId");
CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverride_sessionId_idx"
  ON "RevenueAIStyleOverride" ("sessionId");
CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverride_expiresAt_idx"
  ON "RevenueAIStyleOverride" ("expiresAt");

CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverrideAudit_botId_idx"
  ON "RevenueAIStyleOverrideAudit" ("botId");
CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverrideAudit_conversationId_idx"
  ON "RevenueAIStyleOverrideAudit" ("conversationId");
CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverrideAudit_sessionId_idx"
  ON "RevenueAIStyleOverrideAudit" ("sessionId");
CREATE INDEX IF NOT EXISTS "RevenueAIStyleOverrideAudit_createdAt_idx"
  ON "RevenueAIStyleOverrideAudit" ("createdAt");

DO $$
BEGIN
  ALTER TABLE "RevenueAIStyleOverride"
    ADD CONSTRAINT "RevenueAIStyleOverride_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIStyleOverride"
    ADD CONSTRAINT "RevenueAIStyleOverride_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIStyleOverrideAudit"
    ADD CONSTRAINT "RevenueAIStyleOverrideAudit_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RevenueAIStyleOverrideAudit"
    ADD CONSTRAINT "RevenueAIStyleOverrideAudit_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
