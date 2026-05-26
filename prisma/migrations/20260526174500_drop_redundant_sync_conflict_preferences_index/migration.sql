-- Drop redundant unique index created by @@unique([id]); the primary key
-- already enforces uniqueness for the singleton row id.
DROP INDEX IF EXISTS "SyncConflictPreferences_id_key";
