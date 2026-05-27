-- Speed up suppression checks for recurring ignored sync conflicts.
CREATE INDEX "SyncConflictReview_articleId_relativePath_direction_status_idx"
  ON "SyncConflictReview"("articleId", "relativePath", "direction", "status");
