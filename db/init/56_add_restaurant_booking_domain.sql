-- 56_add_restaurant_booking_domain.sql
-- Purpose:
--   1) Add explicit booking system selection on Bot (`bookingSystemType`).
--   2) Create a separate restaurant booking domain (config, rooms, tables, joins, reservations, audit logs).
--
-- Rollout notes:
--   - Run this script manually in production.
--   - It is designed to be idempotent where reasonably possible.
--   - Existing bots default to GENERIC mode for backward compatibility.
--
-- Assumptions:
--   - PostgreSQL database.
--   - `pgcrypto` extension is available (or can be enabled) for gen_random_uuid().

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BookingSystemType') THEN
    CREATE TYPE "BookingSystemType" AS ENUM ('GENERIC', 'RESTAURANT');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RestaurantSmokingPreference') THEN
    CREATE TYPE "RestaurantSmokingPreference" AS ENUM ('NO_PREFERENCE', 'SMOKING', 'NON_SMOKING');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RestaurantReservationStatus') THEN
    CREATE TYPE "RestaurantReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED', 'EXPIRED', 'NO_SHOW');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RestaurantReservationSource') THEN
    CREATE TYPE "RestaurantReservationSource" AS ENUM ('AI', 'STAFF', 'CUSTOMER', 'SYSTEM');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RestaurantReservationActor') THEN
    CREATE TYPE "RestaurantReservationActor" AS ENUM ('AI', 'STAFF', 'CUSTOMER', 'SYSTEM');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RestaurantTableManualState') THEN
    CREATE TYPE "RestaurantTableManualState" AS ENUM ('AUTO', 'FREE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE');
  END IF;
END
$$;

ALTER TABLE "Bot"
  ADD COLUMN IF NOT EXISTS "bookingSystemType" "BookingSystemType" NOT NULL DEFAULT 'GENERIC';

UPDATE "Bot"
SET "bookingSystemType" = 'GENERIC'
WHERE "bookingSystemType" IS NULL;

CREATE TABLE IF NOT EXISTS "RestaurantConfig" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL UNIQUE,
  "timeZone" text,
  "openingHours" jsonb,
  "closedDates" text[] NOT NULL DEFAULT '{}',
  "defaultDurationMinutes" integer NOT NULL DEFAULT 90,
  "bufferMinutes" integer NOT NULL DEFAULT 15,
  "autoBookingSaturationPct" integer NOT NULL DEFAULT 85,
  "oversizeToleranceSeats" integer NOT NULL DEFAULT 2,
  "allowJoinedTables" boolean NOT NULL DEFAULT true,
  "joinedTablesFallbackOnly" boolean NOT NULL DEFAULT true,
  "maxJoinedTables" integer NOT NULL DEFAULT 2,
  "lateArrivalGraceMinutes" integer NOT NULL DEFAULT 15,
  "noShowAfterMinutes" integer NOT NULL DEFAULT 30,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantConfig_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "RestaurantRoom" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL,
  "name" text NOT NULL,
  "notes" text,
  "displayOrder" integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantRoom_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantRoom_botId_name_key"
  ON "RestaurantRoom" ("botId", "name");

CREATE INDEX IF NOT EXISTS "RestaurantRoom_botId_displayOrder_idx"
  ON "RestaurantRoom" ("botId", "displayOrder");

CREATE TABLE IF NOT EXISTS "RestaurantTable" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL,
  "roomId" text NOT NULL,
  "code" text NOT NULL,
  "capacity" integer NOT NULL,
  "isSmoking" boolean NOT NULL DEFAULT false,
  "notes" text,
  "isAiBookable" boolean NOT NULL DEFAULT true,
  "isActive" boolean NOT NULL DEFAULT true,
  "manualState" "RestaurantTableManualState" NOT NULL DEFAULT 'AUTO',
  "manualStateUpdatedAt" timestamptz,
  "manualStateNote" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantTable_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE,
  CONSTRAINT "RestaurantTable_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "RestaurantRoom"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantTable_roomId_code_key"
  ON "RestaurantTable" ("roomId", "code");

CREATE INDEX IF NOT EXISTS "RestaurantTable_botId_roomId_idx"
  ON "RestaurantTable" ("botId", "roomId");

CREATE TABLE IF NOT EXISTS "RestaurantTableJoin" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL,
  "name" text NOT NULL,
  "isActive" boolean NOT NULL DEFAULT true,
  "allowAiBooking" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantTableJoin_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantTableJoin_botId_name_key"
  ON "RestaurantTableJoin" ("botId", "name");

CREATE INDEX IF NOT EXISTS "RestaurantTableJoin_botId_idx"
  ON "RestaurantTableJoin" ("botId");

CREATE TABLE IF NOT EXISTS "RestaurantTableJoinMember" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "joinId" text NOT NULL,
  "tableId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantTableJoinMember_joinId_fkey"
    FOREIGN KEY ("joinId") REFERENCES "RestaurantTableJoin"("id") ON DELETE CASCADE,
  CONSTRAINT "RestaurantTableJoinMember_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantTableJoinMember_joinId_tableId_key"
  ON "RestaurantTableJoinMember" ("joinId", "tableId");

CREATE INDEX IF NOT EXISTS "RestaurantTableJoinMember_tableId_idx"
  ON "RestaurantTableJoinMember" ("tableId");

CREATE TABLE IF NOT EXISTS "RestaurantReservation" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL,
  "source" "RestaurantReservationSource" NOT NULL DEFAULT 'AI',
  "status" "RestaurantReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
  "customerName" text NOT NULL,
  "customerEmail" text NOT NULL,
  "customerPhone" text NOT NULL,
  "partySize" integer NOT NULL,
  "smokingPreference" "RestaurantSmokingPreference" NOT NULL DEFAULT 'NO_PREFERENCE',
  "notes" text,
  "startAt" timestamptz NOT NULL,
  "endAt" timestamptz NOT NULL,
  "durationMinutes" integer NOT NULL,
  "bufferMinutes" integer NOT NULL,
  "aiAutoApproved" boolean NOT NULL DEFAULT false,
  "saturationPercentAtBooking" integer,
  "checkInTokenHash" text,
  "checkInTokenIssuedAt" timestamptz,
  "checkedInAt" timestamptz,
  "cancelledAt" timestamptz,
  "cancelledBy" "RestaurantReservationActor",
  "noShowMarkedAt" timestamptz,
  "completedAt" timestamptz,
  "expiredAt" timestamptz,
  "createdByUserId" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantReservation_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantReservation_checkInTokenHash_key"
  ON "RestaurantReservation" ("checkInTokenHash")
  WHERE "checkInTokenHash" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "RestaurantReservation_botId_startAt_idx"
  ON "RestaurantReservation" ("botId", "startAt");

CREATE INDEX IF NOT EXISTS "RestaurantReservation_botId_status_startAt_idx"
  ON "RestaurantReservation" ("botId", "status", "startAt");

CREATE INDEX IF NOT EXISTS "RestaurantReservation_customerEmail_idx"
  ON "RestaurantReservation" ("customerEmail");

CREATE TABLE IF NOT EXISTS "RestaurantReservationTable" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "reservationId" text NOT NULL,
  "tableId" text NOT NULL,
  "role" text NOT NULL DEFAULT 'PRIMARY',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantReservationTable_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "RestaurantReservation"("id") ON DELETE CASCADE,
  CONSTRAINT "RestaurantReservationTable_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantReservationTable_reservationId_tableId_key"
  ON "RestaurantReservationTable" ("reservationId", "tableId");

CREATE INDEX IF NOT EXISTS "RestaurantReservationTable_tableId_idx"
  ON "RestaurantReservationTable" ("tableId");

CREATE TABLE IF NOT EXISTS "RestaurantAuditLog" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "botId" text NOT NULL,
  "reservationId" text,
  "tableId" text,
  "action" text NOT NULL,
  "actor" "RestaurantReservationActor" NOT NULL DEFAULT 'SYSTEM',
  "actorUserId" text,
  "details" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "RestaurantAuditLog_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE,
  CONSTRAINT "RestaurantAuditLog_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "RestaurantReservation"("id") ON DELETE SET NULL,
  CONSTRAINT "RestaurantAuditLog_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "RestaurantAuditLog_botId_createdAt_idx"
  ON "RestaurantAuditLog" ("botId", "createdAt");

CREATE INDEX IF NOT EXISTS "RestaurantAuditLog_reservationId_idx"
  ON "RestaurantAuditLog" ("reservationId");

CREATE INDEX IF NOT EXISTS "RestaurantAuditLog_tableId_idx"
  ON "RestaurantAuditLog" ("tableId");
