-- Composite index on Article(updatedAt DESC, id ASC) to support the lint query's
-- ORDER BY [{ updatedAt: 'desc' }, { id: 'asc' }] without a sort step.
-- The IF NOT EXISTS guard handles environments where the index was applied manually
-- (e.g. hotfix) but the migration hadn't been recorded in _prisma_migrations yet.
CREATE INDEX IF NOT EXISTS "Article_updatedAt_idx" ON "Article"("updatedAt" DESC, "id" ASC);
