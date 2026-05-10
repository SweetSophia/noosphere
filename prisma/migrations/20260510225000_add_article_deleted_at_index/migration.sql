-- Ensure soft-delete filtering remains indexed on databases created before
-- Article_deletedAt_idx was added to the initial migration snapshot.
CREATE INDEX IF NOT EXISTS "Article_deletedAt_idx" ON "Article"("deletedAt");
