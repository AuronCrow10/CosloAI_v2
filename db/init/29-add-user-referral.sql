ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "referralCodeId" TEXT,
  ADD COLUMN IF NOT EXISTS "referredAt" TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_referralCodeId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_referralCodeId_fkey"
      FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "User_referralCodeId_idx" ON "User" ("referralCodeId");