-- Final, version-safe fix for ShopifyPolicy table/columns.
-- Works on older Postgres (no RENAME COLUMN IF EXISTS).
-- Safe to run multiple times.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'ShopifyPolicy'
  ) THEN
    -- If legacy lowercase table exists, rename it.
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'shopify_policy'
    ) THEN
      EXECUTE 'ALTER TABLE shopify_policy RENAME TO "ShopifyPolicy"';
    ELSE
      -- Create fresh table with Prisma-expected names.
      EXECUTE '
        CREATE TABLE "ShopifyPolicy" (
          id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          "shopId" text NOT NULL REFERENCES "ShopifyShop"(id) ON DELETE CASCADE,
          type text NOT NULL,
          title text,
          body text,
          url text,
          "shopifyUpdatedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT shopify_policy_shop_type_unique UNIQUE ("shopId", type)
        )';
    END IF;
  END IF;

  -- Rename columns if legacy snake_case exists.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ShopifyPolicy' AND column_name = 'shop_id'
  ) THEN
    EXECUTE 'ALTER TABLE "ShopifyPolicy" RENAME COLUMN shop_id TO "shopId"';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ShopifyPolicy' AND column_name = 'shopify_updated_at'
  ) THEN
    EXECUTE 'ALTER TABLE "ShopifyPolicy" RENAME COLUMN shopify_updated_at TO "shopifyUpdatedAt"';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ShopifyPolicy' AND column_name = 'created_at'
  ) THEN
    EXECUTE 'ALTER TABLE "ShopifyPolicy" RENAME COLUMN created_at TO "createdAt"';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ShopifyPolicy' AND column_name = 'updated_at'
  ) THEN
    EXECUTE 'ALTER TABLE "ShopifyPolicy" RENAME COLUMN updated_at TO "updatedAt"';
  END IF;

  -- Ensure constraints/indexes exist.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'shopify_policy_shop_type_unique'
  ) THEN
    EXECUTE 'ALTER TABLE "ShopifyPolicy" ADD CONSTRAINT shopify_policy_shop_type_unique UNIQUE ("shopId", type)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ShopifyPolicy'
      AND indexname = 'shopify_policy_shop_id_idx'
  ) THEN
    EXECUTE 'CREATE INDEX shopify_policy_shop_id_idx ON "ShopifyPolicy" ("shopId")';
  END IF;
END $$;
