-- CreateTable
CREATE TABLE "SyncConflictPreferences" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultBehavior" TEXT NOT NULL DEFAULT 'manual-review',
    "noosphereToVault" TEXT NOT NULL DEFAULT 'manual-review',
    "vaultToNoosphere" TEXT NOT NULL DEFAULT 'manual-review',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncConflictPreferences_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SyncConflictPreferences" ADD CONSTRAINT "SyncConflictPreferences_defaultBehavior_check" CHECK ("defaultBehavior" IN ('preserve', 'overwrite', 'manual-review'));
ALTER TABLE "SyncConflictPreferences" ADD CONSTRAINT "SyncConflictPreferences_noosphereToVault_check" CHECK ("noosphereToVault" IN ('preserve', 'overwrite', 'manual-review'));
ALTER TABLE "SyncConflictPreferences" ADD CONSTRAINT "SyncConflictPreferences_vaultToNoosphere_check" CHECK ("vaultToNoosphere" IN ('preserve', 'overwrite', 'manual-review'));

-- CreateIndex
CREATE UNIQUE INDEX "SyncConflictPreferences_id_key" ON "SyncConflictPreferences"("id");
