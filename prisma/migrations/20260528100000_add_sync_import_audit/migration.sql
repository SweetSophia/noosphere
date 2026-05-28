-- CreateTable
CREATE TABLE "SyncImportAudit" (
    "id" TEXT NOT NULL,
    "articleId" TEXT,
    "relativePath" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "forceOverwrite" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL,
    "markdownHash" TEXT,
    "noosphereHash" TEXT,
    "conflictReason" TEXT,
    "performedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncImportAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncImportAudit_articleId_idx" ON "SyncImportAudit"("articleId");

-- CreateIndex
CREATE INDEX "SyncImportAudit_action_idx" ON "SyncImportAudit"("action");

-- CreateIndex
CREATE INDEX "SyncImportAudit_kind_idx" ON "SyncImportAudit"("kind");

-- CreateIndex
CREATE INDEX "SyncImportAudit_createdAt_idx" ON "SyncImportAudit"("createdAt");

-- CreateIndex
CREATE INDEX "SyncImportAudit_relativePath_idx" ON "SyncImportAudit"("relativePath");

-- CreateIndex
CREATE INDEX "SyncImportAudit_performedBy_idx" ON "SyncImportAudit"("performedBy");

-- AddForeignKey
ALTER TABLE "SyncImportAudit" ADD CONSTRAINT "SyncImportAudit_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;
