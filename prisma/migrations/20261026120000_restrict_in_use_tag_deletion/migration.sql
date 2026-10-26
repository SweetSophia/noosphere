-- The earlier count is only a friendly diagnostic. The FK is the invariant:
-- if a linking transaction wins, DELETE fails instead of cascading its link;
-- if DELETE wins, the link fails instead of reporting a successful association.
ALTER TABLE "ArticleTag" DROP CONSTRAINT "ArticleTag_tagId_fkey";
ALTER TABLE "ArticleTag" ADD CONSTRAINT "ArticleTag_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
