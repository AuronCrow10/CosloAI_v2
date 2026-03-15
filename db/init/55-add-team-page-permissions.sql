-- Team page-level permissions per bot membership/invite

ALTER TABLE "TeamInviteBot"
  ADD COLUMN IF NOT EXISTS "pagePermissions" TEXT[] NOT NULL DEFAULT ARRAY['BOT_DETAIL'];

ALTER TABLE "TeamMembership"
  ADD COLUMN IF NOT EXISTS "pagePermissions" TEXT[] NOT NULL DEFAULT ARRAY['BOT_DETAIL'];

UPDATE "TeamInviteBot"
SET "pagePermissions" = ARRAY['BOT_DETAIL']
WHERE "pagePermissions" IS NULL;

UPDATE "TeamMembership"
SET "pagePermissions" = ARRAY['BOT_DETAIL']
WHERE "pagePermissions" IS NULL;
