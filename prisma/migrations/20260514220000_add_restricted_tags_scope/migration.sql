-- Add restricted access scopes to articles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Article' AND column_name = 'restrictedTags'
  ) THEN
    ALTER TABLE "Article" ADD COLUMN "restrictedTags" TEXT[] DEFAULT '{}'::TEXT[];
  END IF;
END $$;

-- Add allowed scopes to API keys
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ApiKey' AND column_name = 'allowedScopes'
  ) THEN
    ALTER TABLE "ApiKey" ADD COLUMN "allowedScopes" TEXT[] DEFAULT '{}'::TEXT[];
  END IF;
END $$;

-- Create RestrictedScope registry table
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'RestrictedScope') THEN
    CREATE TABLE "RestrictedScope" (
      "id" TEXT NOT NULL PRIMARY KEY DEFAULT replace(gen_random_uuid()::text, '-', ''),
      "tag" TEXT NOT NULL UNIQUE,
      "description" TEXT,
      "isSystem" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  END IF;
END $$;

-- Index for fast scope lookups
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'Article_restrictedTags_idx'
  ) THEN
    CREATE INDEX "Article_restrictedTags_idx" ON "Article" USING GIN ("restrictedTags");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'ApiKey_allowedScopes_idx'
  ) THEN
    CREATE INDEX "ApiKey_allowedScopes_idx" ON "ApiKey" USING GIN ("allowedScopes");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'RestrictedScope_tag_idx'
  ) THEN
    CREATE INDEX "RestrictedScope_tag_idx" ON "RestrictedScope"("tag");
  END IF;
END $$;

-- Seed system scopes (idempotent — uses ON CONFLICT DO NOTHING)
INSERT INTO "RestrictedScope" ("id", "tag", "description", "isSystem", "createdAt")
SELECT replace(gen_random_uuid()::text, '-', ''), tag, description, true, now()
FROM (VALUES
  ('health',    'Personal health and medical information'),
  ('intimate', 'Intimate and relationship content'),
  ('identity', 'Personal identity and self-discovery'),
  ('financial', 'Financial data and sensitive business info'),
  ('social',   'Social relationships and external contacts')
) AS v(tag, description)
ON CONFLICT ("tag") DO NOTHING;
