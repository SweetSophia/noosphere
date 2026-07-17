\set ON_ERROR_STOP on

SET TIME ZONE 'UTC';

BEGIN;

INSERT INTO "User" (
  "id", "email", "name", "passwordHash", "role", "createdAt", "updatedAt"
) VALUES (
  'rehearsal-user', 'rehearsal@example.invalid', 'Upgrade Rehearsal',
  'not-a-real-password-hash', 'ADMIN',
  '2026-01-02 03:04:05+00', '2026-01-02 03:04:05+00'
);

INSERT INTO "Session" ("id", "sessionToken", "userId", "expires") VALUES
  ('rehearsal-session', 'rehearsal-session-token', 'rehearsal-user', '2026-02-02 03:04:05+00');

INSERT INTO "Topic" (
  "id", "name", "slug", "parentId", "description", "createdAt", "updatedAt"
) VALUES
  ('rehearsal-topic-root', 'Zebra Root', 'rehearsal-root', NULL,
   'Root used by the isolated volume rehearsal.', '2026-01-02 03:04:05+00', '2026-01-02 03:04:05+00'),
  ('rehearsal-topic-child', 'Ångström Child', 'rehearsal-child', 'rehearsal-topic-root',
   NULL, '2026-01-02 03:04:06+00', '2026-01-02 03:04:06+00');

INSERT INTO "Article" (
  "id", "title", "slug", "content", "excerpt", "authorId", "authorName",
  "topicId", "createdAt", "updatedAt", "sourceUrl", "sourceType",
  "confidence", "status", "lastReviewed", "deletedAt", "restrictedTags",
  "recallQuarantinedAt", "recallQuarantineReason", "memoryRevocationGeneration"
) VALUES
  ('rehearsal-article-a', 'Apple Article', 'apple-article', 'Deterministic content A.',
   'Fixture A', 'rehearsal-user', 'Upgrade Rehearsal', 'rehearsal-topic-child',
   '2026-01-02 03:04:07+00', '2026-01-02 03:04:07+00',
   'https://example.invalid/a', 'manual', 'high', 'reviewed',
   '2026-01-02 03:04:08+00', NULL, ARRAY['private:rehearsal', 'team:database'],
   NULL, NULL, 2),
  ('rehearsal-article-b', 'Nullable Article', 'nullable-article', 'Deterministic content B.',
   NULL, NULL, NULL, 'rehearsal-topic-child',
   '2026-01-02 03:04:09+00', '2026-01-02 03:04:09+00',
   NULL, NULL, NULL, 'draft', NULL, NULL, ARRAY[]::text[], NULL, NULL, 0);

INSERT INTO "Tag" ("id", "name", "slug", "createdAt") VALUES
  ('rehearsal-tag-a', 'Upgrade', 'upgrade', '2026-01-02 03:04:10+00'),
  ('rehearsal-tag-b', 'Rollback', 'rollback', '2026-01-02 03:04:10+00');

INSERT INTO "ArticleTag" ("articleId", "tagId") VALUES
  ('rehearsal-article-a', 'rehearsal-tag-a'),
  ('rehearsal-article-a', 'rehearsal-tag-b');

INSERT INTO "ArticleRevision" (
  "id", "articleId", "authorId", "title", "content", "createdAt"
) VALUES (
  'rehearsal-revision', 'rehearsal-article-a', NULL,
  'Apple Article v1', 'Revision with a nullable author.', '2026-01-02 03:04:11+00'
);

-- The scope migration deliberately generates UUIDs and timestamps for its
-- five system seeds. Canonicalize those non-semantic values so the committed
-- all-table digest is reproducible across clean rehearsal runs.
UPDATE "RestrictedScope"
SET "id" = 'rehearsal-system-' || "tag",
    "createdAt" = '2026-01-02 03:04:12+00'
WHERE "isSystem" = true;

INSERT INTO "RestrictedScope" (
  "id", "tag", "description", "isSystem", "createdAt"
) VALUES (
  'rehearsalscope00000000000000000000', 'private:rehearsal',
  'Isolated rehearsal scope.', false, '2026-01-02 03:04:12+00'
);

INSERT INTO "MemoryAgentPrincipal" (
  "id", "name", "privateScopeTag", "status", "revocationGeneration",
  "revokedAt", "createdAt", "updatedAt"
) VALUES (
  'rehearsal-principal', 'upgrade-rehearsal', 'private:rehearsal', 'ACTIVE', 0,
  NULL, '2026-01-02 03:04:13+00', '2026-01-02 03:04:13+00'
);

INSERT INTO "MemoryCapture" (
  "id", "dedupeKey", "dedupeKeyVersion", "hmacAlgorithm",
  "agentPrincipalId", "privateScopeTag", "sourceSessionHash",
  "sourceSessionKeyVersion", "sourceRunHash", "sourceRunKeyVersion",
  "sourceType", "userText", "assistantText", "restrictedTags", "status",
  "occurrenceCount", "firstSeenAt", "lastSeenAt", "leaseOwner",
  "leaseExpiresAt", "attemptCount", "nextAttemptAt", "expiresAt",
  "quarantinedAt", "createdAt", "updatedAt"
) VALUES (
  'rehearsal-capture', 'rehearsal-capture-dedupe', 1, 'HMAC-SHA-256',
  'rehearsal-principal', 'private:rehearsal', 'rehearsal-session-hash', 1,
  NULL, NULL, 'phase_a2_fixture', 'Deterministic private user capture.',
  'Deterministic private assistant capture.', ARRAY['private:rehearsal'],
  'CONVERTED', 3, '2026-01-02 03:04:13+00', '2026-01-02 03:04:14+00',
  NULL, NULL, 1, NULL, '2026-01-20 03:04:13+00', NULL,
  '2026-01-02 03:04:13+00', '2026-01-02 03:04:14+00'
);

INSERT INTO "MemoryCandidate" (
  "id", "dedupeKey", "dedupeKeyVersion", "hmacAlgorithm", "title",
  "content", "recallSummary", "searchTerms", "confidence",
  "restrictedTags", "agentPrincipalId", "privateScopeTag",
  "sourceCaptureId", "status", "occurrenceCount", "retrievedCount",
  "injectedCount", "explicitGetCount", "relevanceSum",
  "distinctSessionCount", "distinctDayCount", "firstSeenAt", "lastSeenAt",
  "lastRetrievedAt", "expiresAt", "promotedArticleId", "quarantinedAt",
  "createdAt", "updatedAt"
) VALUES (
  'rehearsal-candidate', 'rehearsal-candidate-dedupe', 1, 'HMAC-SHA-256',
  'Candidate volume rehearsal', 'Deterministic private candidate content.',
  'Deterministic candidate recall summary.', ARRAY['volume', 'rollback'],
  'high', ARRAY['private:rehearsal'], 'rehearsal-principal',
  'private:rehearsal', 'rehearsal-capture', 'PENDING_REVIEW', 2, 4, 2, 1,
  2.375, 3, 2, '2026-01-02 03:04:14+00', '2026-01-02 03:04:15+00',
  '2026-01-02 03:04:15+00', '2026-02-01 03:04:14+00', NULL, NULL,
  '2026-01-02 03:04:14+00', '2026-01-02 03:04:15+00'
);

INSERT INTO "ApiKey" (
  "id", "name", "keyHash", "keyPrefix", "permissions", "allowedScopes",
  "agentPrincipalId", "createdAt", "lastUsedAt", "revokedAt"
) VALUES (
  'rehearsal-api-key', 'Upgrade Rehearsal', 'rehearsal-key-hash', 'noo_test',
  'ADMIN', ARRAY['private:rehearsal', 'team:database'], 'rehearsal-principal',
  '2026-01-02 03:04:14+00', NULL, NULL
);

INSERT INTO "ActivityLog" (
  "id", "type", "title", "details", "sourceUrl", "authorName", "createdAt"
) VALUES (
  'rehearsal-activity', 'rehearsal', 'Volume rehearsal fixture',
  '{"nested":{"enabled":true},"numbers":[1,2,3],"nullable":null}'::jsonb,
  NULL, 'Upgrade Rehearsal', '2026-01-02 03:04:15+00'
);

INSERT INTO "ArticleRelation" ("id", "sourceId", "targetId", "createdAt") VALUES
  ('rehearsal-relation', 'rehearsal-article-a', 'rehearsal-article-b', '2026-01-02 03:04:16+00');

INSERT INTO "RecallSettings" (
  "id", "autoRecallEnabled", "maxInjectedMemories", "maxInjectedTokens",
  "recallVerbosity", "summaryFirst", "deduplicationStrategy",
  "enabledProviders", "providerPriorityWeights", "conflictStrategy",
  "conflictThreshold", "updatedAt"
) VALUES (
  'singleton', true, 7, 777, 'detailed', false, 'provider-priority',
  ARRAY['noosphere', 'lossless-claw'], '{"lossless-claw":0.25,"noosphere":0.75}'::jsonb,
  'accept-curated', 0.25, '2026-01-02 03:04:17+00'
);

INSERT INTO "SyncConflictPreferences" (
  "id", "defaultBehavior", "noosphereToVault", "vaultToNoosphere", "updatedAt"
) VALUES (
  'singleton', 'manual-review', 'preserve', 'overwrite', '2026-01-02 03:04:18+00'
);

INSERT INTO "SyncConflictReview" (
  "id", "articleId", "direction", "status", "resolution", "relativePath",
  "archivePath", "noosphereHash", "markdownHash", "noosphereUpdatedAt",
  "markdownUpdatedAt", "summary", "createdAt", "updatedAt", "resolvedAt", "resolvedBy"
) VALUES (
  'rehearsal-conflict', 'rehearsal-article-a', 'vault-to-noosphere', 'resolved',
  'keep-noosphere', 'rehearsal/apple.md', 'archive/rehearsal/apple.md',
  'noosphere-hash', 'markdown-hash', '2026-01-02 03:04:19+00',
  '2026-01-02 03:04:20+00', '{"decision":"keep","paths":["a","b"]}'::jsonb,
  '2026-01-02 03:04:21+00', '2026-01-02 03:04:22+00',
  '2026-01-02 03:04:22+00', 'rehearsal-user'
);

INSERT INTO "SyncImportAudit" (
  "id", "articleId", "relativePath", "action", "kind", "dryRun",
  "forceOverwrite", "mode", "markdownHash", "noosphereHash",
  "conflictReason", "performedBy", "createdAt"
) VALUES (
  'rehearsal-import', 'rehearsal-article-a', 'rehearsal/apple.md', 'updated',
  'modified', false, true, 'upsert', 'markdown-hash', 'noosphere-hash',
  NULL, 'rehearsal-user', '2026-01-02 03:04:23+00'
);

INSERT INTO "ArticleRecallEnrichment" (
  "articleId", "sourceHash", "recallSummary", "searchTerms", "generatorKind",
  "generatorId", "promptVersion", "status", "attemptCount", "errorCode",
  "generatedAt", "quarantinedAt", "createdAt", "updatedAt"
) VALUES (
  'rehearsal-article-a', 'rehearsal-source-hash', 'Deterministic recall summary.',
  ARRAY['upgrade', 'rollback'], 'fixture', 'phase-a2', 'v1', 'READY', 1, NULL,
  '2026-01-02 03:04:24+00', NULL,
  '2026-01-02 03:04:24+00', '2026-01-02 03:04:24+00'
);

INSERT INTO "MemoryRetrievalStat" (
  "id", "eventType", "provider", "retrievalMode", "normalizedRelevance",
  "queryCorrelationHash", "queryCorrelationKeyVersion", "sourceSessionHash",
  "sourceSessionKeyVersion", "dayBucket", "boundedContext", "agentPrincipalId",
  "captureId", "candidateId", "articleId", "quarantinedAt", "createdAt"
) VALUES (
  'rehearsal-retrieval', 'EXPLICIT_GET', 'noosphere', 'fixture', 0.875,
  'query-hash', 1, 'session-hash', 1, '2026-01-02',
  '{"rank":1,"source":"phase-a2"}'::jsonb, 'rehearsal-principal',
  'rehearsal-capture', 'rehearsal-candidate', 'rehearsal-article-a', NULL,
  '2026-01-02 03:04:25+00'
);

INSERT INTO "MemoryLineageState" (
  "id", "kind", "subjectHash", "hmacKeyVersion", "agentPrincipalId",
  "generation", "revokedAt", "createdAt", "updatedAt"
) VALUES
  ('rehearsal-lineage', 'PRINCIPAL', 'principal:rehearsal-principal', NULL,
   'rehearsal-principal', 0, NULL, '2026-01-02 03:04:26+00', '2026-01-02 03:04:26+00'),
  ('rehearsal-lineage-scope', 'SCOPE', 'scope:private:rehearsal', NULL,
   NULL, 0, NULL, '2026-01-02 03:04:26+00', '2026-01-02 03:04:26+00'),
  ('rehearsal-lineage-session', 'SESSION', 'rehearsal-session-hash', 1,
   'rehearsal-principal', 0, NULL, '2026-01-02 03:04:26+00', '2026-01-02 03:04:26+00'),
  ('rehearsal-lineage-capture', 'CAPTURE', 'rehearsal-capture-dedupe', 1,
   'rehearsal-principal', 0, NULL, '2026-01-02 03:04:26+00', '2026-01-02 03:04:26+00');

INSERT INTO "MemoryProvenanceEdge" (
  "id", "sourceGroupId", "lineageStateId", "generationSnapshot",
  "captureId", "candidateId", "enrichmentArticleId", "retrievalStatId",
  "articleId", "createdAt"
) VALUES
  ('rehearsal-edge', 'rehearsal-source-group', 'rehearsal-lineage', 0,
   NULL, NULL, NULL, NULL, 'rehearsal-article-a', '2026-01-02 03:04:27+00'),
  ('rehearsal-capture-edge-principal', 'rehearsal-capture-group', 'rehearsal-lineage', 0,
   'rehearsal-capture', NULL, NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-capture-edge-scope', 'rehearsal-capture-group', 'rehearsal-lineage-scope', 0,
   'rehearsal-capture', NULL, NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-capture-edge-session', 'rehearsal-capture-group', 'rehearsal-lineage-session', 0,
   'rehearsal-capture', NULL, NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-capture-edge-capture', 'rehearsal-capture-group', 'rehearsal-lineage-capture', 0,
   'rehearsal-capture', NULL, NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-candidate-edge-principal', 'rehearsal-candidate-group', 'rehearsal-lineage', 0,
   NULL, 'rehearsal-candidate', NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-candidate-edge-scope', 'rehearsal-candidate-group', 'rehearsal-lineage-scope', 0,
   NULL, 'rehearsal-candidate', NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-candidate-edge-session', 'rehearsal-candidate-group', 'rehearsal-lineage-session', 0,
   NULL, 'rehearsal-candidate', NULL, NULL, NULL, '2026-01-02 03:04:27+00'),
  ('rehearsal-candidate-edge-capture', 'rehearsal-candidate-group', 'rehearsal-lineage-capture', 0,
   NULL, 'rehearsal-candidate', NULL, NULL, NULL, '2026-01-02 03:04:27+00');

INSERT INTO "MemoryTombstone" (
  "id", "lineageStateId", "kind", "subjectHash", "hmacKeyVersion",
  "generation", "agentPrincipalId", "reasonCode", "expiresAt", "createdAt"
) VALUES (
  'rehearsal-tombstone', 'rehearsal-lineage', 'PRINCIPAL',
  'rehearsal-subject-hash', NULL, 1, 'rehearsal-principal', 'REHEARSAL',
  '2026-02-02 03:04:28+00', '2026-01-02 03:04:28+00'
);

INSERT INTO "MemoryDurableJob" (
  "id", "kind", "status", "idempotencyKey", "payload", "lineageStateId",
  "agentPrincipalId", "leaseOwner", "leaseExpiresAt", "attemptCount",
  "nextAttemptAt", "maxAttempts", "lastErrorCode", "completedAt", "createdAt", "updatedAt"
) VALUES (
  'rehearsal-job', 'fixture', 'SUCCEEDED', 'rehearsal-job-key',
  '{"operation":"verify","steps":["backup","restore","rollback"]}'::jsonb,
  'rehearsal-lineage', 'rehearsal-principal', NULL, NULL, 1,
  '2026-01-02 03:04:29+00', 3, NULL, '2026-01-02 03:04:30+00',
  '2026-01-02 03:04:29+00', '2026-01-02 03:04:30+00'
);

INSERT INTO "MemoryPrivacyReview" (
  "id", "articleId", "lineageStateId", "generation", "status", "reasonCode",
  "resolvedAt", "resolvedBy", "createdAt", "updatedAt"
) VALUES (
  'rehearsal-privacy', 'rehearsal-article-a', 'rehearsal-lineage', 0,
  'RESOLVED_RETAINED', 'REHEARSAL', '2026-01-02 03:04:31+00',
  'rehearsal-user', '2026-01-02 03:04:31+00', '2026-01-02 03:04:31+00'
);

CREATE TYPE "UpgradeRehearsalState" AS ENUM ('READY', 'COPIED', 'RESTORED');

CREATE TABLE "UpgradeRehearsalFixture" (
  "id" TEXT PRIMARY KEY,
  "parentId" TEXT REFERENCES "UpgradeRehearsalFixture"("id") ON DELETE SET NULL,
  "state" "UpgradeRehearsalState" NOT NULL,
  "labels" TEXT[] NOT NULL,
  "payload" JSONB NOT NULL,
  "sortKey" TEXT COLLATE "default" NOT NULL,
  "nullableNote" TEXT,
  "touchCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "UpgradeRehearsalFixture_payload_object"
    CHECK (jsonb_typeof("payload") = 'object')
);

CREATE FUNCTION "touch_upgrade_rehearsal_fixture"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."touchCount" := NEW."touchCount" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "UpgradeRehearsalFixture_touch"
BEFORE INSERT OR UPDATE ON "UpgradeRehearsalFixture"
FOR EACH ROW
EXECUTE FUNCTION "touch_upgrade_rehearsal_fixture"();

CREATE INDEX "UpgradeRehearsalFixture_sort_idx"
  ON "UpgradeRehearsalFixture" ("sortKey" COLLATE "default", "id");

INSERT INTO "UpgradeRehearsalFixture" (
  "id", "parentId", "state", "labels", "payload", "sortKey", "nullableNote"
) VALUES
  ('fixture-zebra', NULL, 'READY', ARRAY['root', 'zebra'],
   '{"ordinal":1,"valid":true}'::jsonb, 'Zebra', NULL),
  ('fixture-apple', 'fixture-zebra', 'COPIED', ARRAY['child', 'apple'],
   '{"ordinal":2,"valid":true}'::jsonb, 'apple', 'not null'),
  ('fixture-angstrom', 'fixture-zebra', 'RESTORED', ARRAY['child', 'unicode'],
   '{"ordinal":3,"valid":true}'::jsonb, 'Ångström', NULL);

COMMIT;
