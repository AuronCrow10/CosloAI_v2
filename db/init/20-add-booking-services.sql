CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "BookingService" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "aliases" text[] NOT NULL DEFAULT '{}',
  "calendarId" text NOT NULL,
  "durationMinutes" integer NOT NULL,
  "maxSimultaneousBookings" integer,
  "weeklySchedule" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "BookingService_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookingService_botId_key_key" ON "BookingService" ("botId", "key");
CREATE INDEX IF NOT EXISTS "BookingService_botId_idx" ON "BookingService" ("botId");
