-- Create index on Article.updatedAt to improve lint query performance
-- The /api/lint endpoint orders by updatedAt desc and is now capped at 2000 rows,
-- but without an index this ORDER BY causes a full table scan + sort on large wikis.
CREATE INDEX "Article_updatedAt_idx" ON "Article"("updatedAt");
