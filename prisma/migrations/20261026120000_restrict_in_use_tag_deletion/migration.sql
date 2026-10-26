-- The earlier count is only a friendly diagnostic. The FK is the invariant:
-- if a linking transaction wins, DELETE fails instead of cascading its link;
-- if DELETE wins, the link fails instead of reporting a successful association.
-- One statement keeps replacement atomic even when the migration runner does
-- not wrap PostgreSQL migrations in a transaction: no unguarded FK interval.
ALTER TABLE "ArticleTag"
  DROP CONSTRAINT "ArticleTag_tagId_fkey",
  ADD CONSTRAINT "ArticleTag_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
