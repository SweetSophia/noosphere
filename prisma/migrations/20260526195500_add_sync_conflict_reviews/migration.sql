-- CreateTable
CREATE TABLE "SyncConflictReview" (
    "id" TEXT NOT NULL,
    "articleId" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "relativePath" TEXT NOT NULL,
    "archivePath" TEXT NOT NULL,
    "noosphereHash" TEXT,
    "markdownHash" TEXT,
    "noosphereUpdatedAt" TIMESTAMP(3),
    "markdownUpdatedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "SyncConflictReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncConflictReview_archivePath_key" ON "SyncConflictReview"("archivePath");

-- CreateIndex
CREATE INDEX "SyncConflictReview_articleId_idx" ON "SyncConflictReview"("articleId");

-- CreateIndex
CREATE INDEX "SyncConflictReview_status_idx" ON "SyncConflictReview"("status");

-- CreateIndex
CREATE INDEX "SyncConflictReview_direction_idx" ON "SyncConflictReview"("direction");

-- CreateIndex
CREATE INDEX "SyncConflictReview_createdAt_idx" ON "SyncConflictReview"("createdAt");

-- AddForeignKey
ALTER TABLE "SyncConflictReview" ADD CONSTRAINT "SyncConflictReview_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add constraints
ALTER TABLE "SyncConflictReview" ADD CONSTRAINT "SyncConflictReview_direction_check" CHECK ("direction" IN ('noosphere-to-vault', 'vault-to-noosphere'));
ALTER TABLE "SyncConflictReview" ADD CONSTRAINT "SyncConflictReview_status_check" CHECK ("status" IN ('open', 'resolved', 'ignored-once', 'ignored-always'));
ALTER TABLE "SyncConflictReview" ADD CONSTRAINT "SyncConflictReview_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('keep-noosphere', 'keep-markdown', 'mark-resolved', 'ignore-once', 'ignore-always'));
