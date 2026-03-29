-- 57_add_restaurant_table_overlap_guard.sql
-- Purpose:
--   Add a hard DB-level no-overlap guarantee for physical restaurant table allocations.
--   This protects against double-booking under concurrency, including joined-table reservations
--   (each physical table row is constrained independently).
--
-- Rollout notes:
--   - Run after 56_add_restaurant_booking_domain.sql.
--   - PostgreSQL-only (this repository uses PostgreSQL + pgvector).
--   - Designed to be idempotent and production-safe.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "RestaurantReservationTable"
  ADD COLUMN IF NOT EXISTS "blockedFrom" timestamptz,
  ADD COLUMN IF NOT EXISTS "blockedUntil" timestamptz,
  ADD COLUMN IF NOT EXISTS "isBlocking" boolean;

ALTER TABLE "RestaurantReservationTable"
  ALTER COLUMN "isBlocking" SET DEFAULT true;

-- Backfill allocation windows from parent reservation:
-- blockedFrom = reservation.startAt - bufferMinutes
-- blockedUntil = reservation.endAt + bufferMinutes
-- isBlocking = reservation.status in PENDING/CONFIRMED/CHECKED_IN
UPDATE "RestaurantReservationTable" AS rrt
SET
  "blockedFrom" = rr."startAt" - make_interval(mins => GREATEST(0, COALESCE(rr."bufferMinutes", 0))),
  "blockedUntil" = rr."endAt" + make_interval(mins => GREATEST(0, COALESCE(rr."bufferMinutes", 0))),
  "isBlocking" = (rr."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN'))
FROM "RestaurantReservation" AS rr
WHERE rr."id" = rrt."reservationId"
  AND (
    rrt."blockedFrom" IS NULL
    OR rrt."blockedUntil" IS NULL
    OR rrt."isBlocking" IS NULL
  );

-- Fail early if some rows could not be backfilled.
DO $$
DECLARE
  v_missing bigint;
BEGIN
  SELECT COUNT(*) INTO v_missing
  FROM "RestaurantReservationTable"
  WHERE "blockedFrom" IS NULL OR "blockedUntil" IS NULL OR "isBlocking" IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'Restaurant overlap guard rollout aborted: % allocation rows are missing blocked window data.',
      v_missing;
  END IF;
END
$$;

ALTER TABLE "RestaurantReservationTable"
  ALTER COLUMN "blockedFrom" SET NOT NULL,
  ALTER COLUMN "blockedUntil" SET NOT NULL,
  ALTER COLUMN "isBlocking" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'RestaurantReservationTable_block_window_valid'
  ) THEN
    ALTER TABLE "RestaurantReservationTable"
      ADD CONSTRAINT "RestaurantReservationTable_block_window_valid"
      CHECK ("blockedUntil" > "blockedFrom");
  END IF;
END
$$;

-- Keep allocation rows automatically aligned with reservation data.
CREATE OR REPLACE FUNCTION "sync_restaurant_reservation_table_window_from_reservation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rr RECORD;
BEGIN
  SELECT
    r."startAt" AS "startAt",
    r."endAt" AS "endAt",
    r."bufferMinutes" AS "bufferMinutes",
    r."status" AS "status"
  INTO rr
  FROM "RestaurantReservation" r
  WHERE r."id" = NEW."reservationId";

  IF rr IS NULL THEN
    RAISE EXCEPTION 'RestaurantReservation % not found for allocation row.', NEW."reservationId";
  END IF;

  IF NEW."blockedFrom" IS NULL THEN
    NEW."blockedFrom" :=
      rr."startAt" - make_interval(mins => GREATEST(0, COALESCE(rr."bufferMinutes", 0)));
  END IF;

  IF NEW."blockedUntil" IS NULL THEN
    NEW."blockedUntil" :=
      rr."endAt" + make_interval(mins => GREATEST(0, COALESCE(rr."bufferMinutes", 0)));
  END IF;

  IF NEW."isBlocking" IS NULL THEN
    NEW."isBlocking" := rr."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN');
  END IF;

  IF NEW."blockedUntil" <= NEW."blockedFrom" THEN
    RAISE EXCEPTION 'blockedUntil must be greater than blockedFrom';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "trg_restaurant_reservation_table_sync_window"
  ON "RestaurantReservationTable";

CREATE TRIGGER "trg_restaurant_reservation_table_sync_window"
BEFORE INSERT OR UPDATE OF "reservationId", "blockedFrom", "blockedUntil", "isBlocking"
ON "RestaurantReservationTable"
FOR EACH ROW
EXECUTE FUNCTION "sync_restaurant_reservation_table_window_from_reservation"();

CREATE OR REPLACE FUNCTION "sync_restaurant_reservation_allocations_from_reservation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "RestaurantReservationTable"
  SET
    "blockedFrom" =
      NEW."startAt" - make_interval(mins => GREATEST(0, COALESCE(NEW."bufferMinutes", 0))),
    "blockedUntil" =
      NEW."endAt" + make_interval(mins => GREATEST(0, COALESCE(NEW."bufferMinutes", 0))),
    "isBlocking" = (NEW."status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN'))
  WHERE "reservationId" = NEW."id";

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "trg_restaurant_reservation_sync_allocations"
  ON "RestaurantReservation";

CREATE TRIGGER "trg_restaurant_reservation_sync_allocations"
AFTER UPDATE OF "startAt", "endAt", "bufferMinutes", "status"
ON "RestaurantReservation"
FOR EACH ROW
EXECUTE FUNCTION "sync_restaurant_reservation_allocations_from_reservation"();

CREATE INDEX IF NOT EXISTS "RestaurantReservationTable_tableId_isBlocking_idx"
  ON "RestaurantReservationTable" ("tableId", "isBlocking");

-- Preflight check: do not add the exclusion constraint when existing active data conflicts.
DO $$
DECLARE
  v_conflicts bigint;
BEGIN
  SELECT COUNT(*) INTO v_conflicts
  FROM "RestaurantReservationTable" a
  JOIN "RestaurantReservationTable" b
    ON a."id" < b."id"
   AND a."tableId" = b."tableId"
   AND a."isBlocking" = true
   AND b."isBlocking" = true
   AND tstzrange(a."blockedFrom", a."blockedUntil", '[)')
       && tstzrange(b."blockedFrom", b."blockedUntil", '[)');

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION
      'Restaurant overlap guard rollout aborted: found % conflicting active allocation pair(s).',
      v_conflicts;
  END IF;
END
$$;

-- Hard guarantee:
-- for active allocations, same physical table cannot have overlapping windows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'RestaurantReservationTable_tableId_block_window_excl'
  ) THEN
    ALTER TABLE "RestaurantReservationTable"
      ADD CONSTRAINT "RestaurantReservationTable_tableId_block_window_excl"
      EXCLUDE USING gist (
        "tableId" WITH =,
        tstzrange("blockedFrom", "blockedUntil", '[)') WITH &&
      )
      WHERE ("isBlocking");
  END IF;
END
$$;
