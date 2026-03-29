-- 58_allow_restaurant_table_code_reuse_across_rooms.sql
-- Purpose:
--   Allow the same table code in different rooms for the same restaurant bot.
--   Example: Room 1 -> table "1", Room 2 -> table "1" should be valid.
--
-- Rollout notes:
--   - Run after 56_add_restaurant_booking_domain.sql.
--   - Safe to run multiple times.
--   - Keeps strict uniqueness within each room.
--
-- Preflight safety:
--   Fail if duplicate table codes already exist inside the same room.
DO $$
DECLARE
  v_conflicts bigint;
BEGIN
  SELECT COUNT(*) INTO v_conflicts
  FROM (
    SELECT "roomId", "code"
    FROM "RestaurantTable"
    GROUP BY "roomId", "code"
    HAVING COUNT(*) > 1
  ) q;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION
      'Room-level table code uniqueness check failed: found % conflicting room/code pair(s).',
      v_conflicts;
  END IF;
END
$$;

-- Remove legacy uniqueness scope (per bot).
DROP INDEX IF EXISTS "RestaurantTable_botId_code_key";

-- Enforce correct uniqueness scope (per room).
CREATE UNIQUE INDEX IF NOT EXISTS "RestaurantTable_roomId_code_key"
  ON "RestaurantTable" ("roomId", "code");

