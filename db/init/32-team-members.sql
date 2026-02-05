-- Team members + invites (manual script)

-- 1) Add TEAM_MEMBER role to enum
DO $$ BEGIN
  ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TEAM_MEMBER';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2) Add lastLoginAt to User (nullable)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP;

-- 3) Team invite tables (ids are TEXT to match existing User/Bot ids)
CREATE TABLE IF NOT EXISTS "TeamInvite" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  "email" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "invitedById" TEXT NOT NULL,
  "usedAt" TIMESTAMP,
  "revokedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "TeamInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "TeamInvite_email_idx" ON "TeamInvite"("email");
CREATE INDEX IF NOT EXISTS "TeamInvite_invitedById_idx" ON "TeamInvite"("invitedById");

CREATE TABLE IF NOT EXISTS "TeamInviteBot" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  "inviteId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "TeamInviteBot_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "TeamInvite"("id") ON DELETE CASCADE,
  CONSTRAINT "TeamInviteBot_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE,
  CONSTRAINT "TeamInviteBot_inviteId_botId_key" UNIQUE ("inviteId", "botId")
);

CREATE INDEX IF NOT EXISTS "TeamInviteBot_botId_idx" ON "TeamInviteBot"("botId");

CREATE TABLE IF NOT EXISTS "TeamMembership" (
  "id" TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "grantedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "TeamMembership_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE,
  CONSTRAINT "TeamMembership_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "TeamMembership_userId_botId_key" UNIQUE ("userId", "botId")
);

CREATE INDEX IF NOT EXISTS "TeamMembership_botId_idx" ON "TeamMembership"("botId");
CREATE INDEX IF NOT EXISTS "TeamMembership_grantedById_idx" ON "TeamMembership"("grantedById");
