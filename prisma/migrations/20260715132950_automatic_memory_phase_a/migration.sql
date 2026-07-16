-- CreateEnum
CREATE TYPE "MemoryPrincipalStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "MemoryCaptureStatus" AS ENUM ('PENDING', 'PROCESSING', 'CONVERTED', 'IGNORED', 'FAILED', 'EXPIRED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "MemoryCandidateStatus" AS ENUM ('EPHEMERAL', 'PENDING_REVIEW', 'REJECTED', 'PROMOTED', 'EXPIRED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "MemoryEnrichmentStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'STALE', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "MemoryRetrievalEvent" AS ENUM ('PROVIDER_HIT', 'FINAL_RANKED', 'INJECTED', 'EXPLICIT_RECALL', 'EXPLICIT_GET');

-- CreateEnum
CREATE TYPE "MemoryLineageKind" AS ENUM ('CAPTURE', 'PRINCIPAL', 'SESSION', 'SCOPE', 'CONSENT');

-- CreateEnum
CREATE TYPE "MemoryJobStatus" AS ENUM ('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MemoryPrivacyReviewStatus" AS ENUM ('OPEN', 'RESOLVED_RETAINED', 'RESOLVED_PURGED');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "agentPrincipalId" TEXT;

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "memoryRevocationGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recallQuarantineReason" TEXT,
ADD COLUMN     "recallQuarantinedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MemoryAgentPrincipal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "privateScopeTag" TEXT NOT NULL,
    "status" "MemoryPrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
    "revocationGeneration" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryAgentPrincipal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryCapture" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "dedupeKeyVersion" INTEGER NOT NULL,
    "hmacAlgorithm" TEXT NOT NULL,
    "agentPrincipalId" TEXT NOT NULL,
    "privateScopeTag" TEXT NOT NULL,
    "sourceSessionHash" TEXT NOT NULL,
    "sourceSessionKeyVersion" INTEGER NOT NULL,
    "sourceRunHash" TEXT,
    "sourceRunKeyVersion" INTEGER,
    "sourceType" TEXT NOT NULL DEFAULT 'openclaw_agent_end',
    "userText" TEXT NOT NULL,
    "assistantText" TEXT NOT NULL,
    "restrictedTags" TEXT[] NOT NULL,
    "status" "MemoryCaptureStatus" NOT NULL DEFAULT 'PENDING',
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryCapture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryCandidate" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "dedupeKeyVersion" INTEGER NOT NULL,
    "hmacAlgorithm" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "recallSummary" TEXT NOT NULL,
    "searchTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" TEXT NOT NULL,
    "restrictedTags" TEXT[] NOT NULL,
    "agentPrincipalId" TEXT NOT NULL,
    "privateScopeTag" TEXT NOT NULL,
    "sourceCaptureId" TEXT,
    "status" "MemoryCandidateStatus" NOT NULL DEFAULT 'EPHEMERAL',
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "retrievedCount" INTEGER NOT NULL DEFAULT 0,
    "injectedCount" INTEGER NOT NULL DEFAULT 0,
    "explicitGetCount" INTEGER NOT NULL DEFAULT 0,
    "relevanceSum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distinctSessionCount" INTEGER NOT NULL DEFAULT 0,
    "distinctDayCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRetrievedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "promotedArticleId" TEXT,
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleRecallEnrichment" (
    "articleId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "recallSummary" TEXT NOT NULL,
    "searchTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generatorKind" TEXT NOT NULL,
    "generatorId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" "MemoryEnrichmentStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "generatedAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleRecallEnrichment_pkey" PRIMARY KEY ("articleId")
);

-- CreateTable
CREATE TABLE "MemoryRetrievalStat" (
    "id" TEXT NOT NULL,
    "eventType" "MemoryRetrievalEvent" NOT NULL,
    "provider" TEXT NOT NULL,
    "retrievalMode" TEXT NOT NULL,
    "normalizedRelevance" DOUBLE PRECISION,
    "queryCorrelationHash" TEXT,
    "queryCorrelationKeyVersion" INTEGER,
    "sourceSessionHash" TEXT,
    "sourceSessionKeyVersion" INTEGER,
    "dayBucket" DATE,
    "boundedContext" JSONB NOT NULL DEFAULT '{}',
    "agentPrincipalId" TEXT,
    "captureId" TEXT,
    "candidateId" TEXT,
    "articleId" TEXT,
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRetrievalStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryLineageState" (
    "id" TEXT NOT NULL,
    "kind" "MemoryLineageKind" NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "hmacKeyVersion" INTEGER,
    "agentPrincipalId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryLineageState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryProvenanceEdge" (
    "id" TEXT NOT NULL,
    "sourceGroupId" TEXT NOT NULL,
    "lineageStateId" TEXT NOT NULL,
    "generationSnapshot" INTEGER NOT NULL,
    "captureId" TEXT,
    "candidateId" TEXT,
    "enrichmentArticleId" TEXT,
    "retrievalStatId" TEXT,
    "articleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryProvenanceEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryTombstone" (
    "id" TEXT NOT NULL,
    "lineageStateId" TEXT NOT NULL,
    "kind" "MemoryLineageKind" NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "hmacKeyVersion" INTEGER,
    "generation" INTEGER NOT NULL,
    "agentPrincipalId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryDurableJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "MemoryJobStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "lineageStateId" TEXT,
    "agentPrincipalId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lastErrorCode" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryDurableJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryPrivacyReview" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "lineageStateId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "MemoryPrivacyReviewStatus" NOT NULL DEFAULT 'OPEN',
    "reasonCode" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryPrivacyReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryAgentPrincipal_name_key" ON "MemoryAgentPrincipal"("name");

-- CreateIndex
CREATE INDEX "MemoryAgentPrincipal_privateScopeTag_idx" ON "MemoryAgentPrincipal"("privateScopeTag");

-- CreateIndex
CREATE INDEX "MemoryAgentPrincipal_status_idx" ON "MemoryAgentPrincipal"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCapture_dedupeKey_key" ON "MemoryCapture"("dedupeKey");

-- CreateIndex
CREATE INDEX "MemoryCapture_agentPrincipalId_privateScopeTag_status_expir_idx" ON "MemoryCapture"("agentPrincipalId", "privateScopeTag", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "MemoryCapture_sourceSessionHash_idx" ON "MemoryCapture"("sourceSessionHash");

-- CreateIndex
CREATE INDEX "MemoryCapture_sourceRunHash_idx" ON "MemoryCapture"("sourceRunHash");

-- CreateIndex
CREATE INDEX "MemoryCapture_leaseExpiresAt_nextAttemptAt_idx" ON "MemoryCapture"("leaseExpiresAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MemoryCapture_quarantinedAt_idx" ON "MemoryCapture"("quarantinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryCandidate_dedupeKey_key" ON "MemoryCandidate"("dedupeKey");

-- CreateIndex
CREATE INDEX "MemoryCandidate_agentPrincipalId_privateScopeTag_status_exp_idx" ON "MemoryCandidate"("agentPrincipalId", "privateScopeTag", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "MemoryCandidate_sourceCaptureId_idx" ON "MemoryCandidate"("sourceCaptureId");

-- CreateIndex
CREATE INDEX "MemoryCandidate_promotedArticleId_idx" ON "MemoryCandidate"("promotedArticleId");

-- CreateIndex
CREATE INDEX "MemoryCandidate_quarantinedAt_idx" ON "MemoryCandidate"("quarantinedAt");

-- CreateIndex
CREATE INDEX "ArticleRecallEnrichment_status_updatedAt_idx" ON "ArticleRecallEnrichment"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ArticleRecallEnrichment_sourceHash_idx" ON "ArticleRecallEnrichment"("sourceHash");

-- CreateIndex
CREATE INDEX "ArticleRecallEnrichment_quarantinedAt_idx" ON "ArticleRecallEnrichment"("quarantinedAt");

-- CreateIndex
CREATE INDEX "MemoryRetrievalStat_candidateId_eventType_createdAt_idx" ON "MemoryRetrievalStat"("candidateId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryRetrievalStat_articleId_eventType_createdAt_idx" ON "MemoryRetrievalStat"("articleId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryRetrievalStat_captureId_idx" ON "MemoryRetrievalStat"("captureId");

-- CreateIndex
CREATE INDEX "MemoryRetrievalStat_agentPrincipalId_sourceSessionHash_idx" ON "MemoryRetrievalStat"("agentPrincipalId", "sourceSessionHash");

-- CreateIndex
CREATE INDEX "MemoryRetrievalStat_quarantinedAt_idx" ON "MemoryRetrievalStat"("quarantinedAt");

-- CreateIndex
CREATE INDEX "MemoryLineageState_agentPrincipalId_kind_idx" ON "MemoryLineageState"("agentPrincipalId", "kind");

-- CreateIndex
CREATE INDEX "MemoryLineageState_revokedAt_idx" ON "MemoryLineageState"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryLineageState_kind_subjectHash_key" ON "MemoryLineageState"("kind", "subjectHash");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_lineageStateId_generationSnapshot_idx" ON "MemoryProvenanceEdge"("lineageStateId", "generationSnapshot");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_sourceGroupId_idx" ON "MemoryProvenanceEdge"("sourceGroupId");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_captureId_idx" ON "MemoryProvenanceEdge"("captureId");

-- CreateIndex
CREATE INDEX "MemoryProvEdge_capture_lineage_generation_idx" ON "MemoryProvenanceEdge"("captureId", "lineageStateId", "generationSnapshot");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_candidateId_idx" ON "MemoryProvenanceEdge"("candidateId");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_enrichmentArticleId_idx" ON "MemoryProvenanceEdge"("enrichmentArticleId");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_retrievalStatId_idx" ON "MemoryProvenanceEdge"("retrievalStatId");

-- CreateIndex
CREATE INDEX "MemoryProvenanceEdge_articleId_idx" ON "MemoryProvenanceEdge"("articleId");

-- CreateIndex
CREATE INDEX "MemoryTombstone_kind_subjectHash_idx" ON "MemoryTombstone"("kind", "subjectHash");

-- CreateIndex
CREATE INDEX "MemoryTombstone_expiresAt_idx" ON "MemoryTombstone"("expiresAt");

-- CreateIndex
CREATE INDEX "MemoryTombstone_agentPrincipalId_idx" ON "MemoryTombstone"("agentPrincipalId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryTombstone_lineageStateId_generation_key" ON "MemoryTombstone"("lineageStateId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryDurableJob_idempotencyKey_key" ON "MemoryDurableJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MemoryDurableJob_status_nextAttemptAt_leaseExpiresAt_idx" ON "MemoryDurableJob"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "MemoryDurableJob_lineageStateId_idx" ON "MemoryDurableJob"("lineageStateId");

-- CreateIndex
CREATE INDEX "MemoryDurableJob_agentPrincipalId_idx" ON "MemoryDurableJob"("agentPrincipalId");

-- CreateIndex
CREATE INDEX "MemoryPrivacyReview_status_createdAt_idx" ON "MemoryPrivacyReview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryPrivacyReview_lineageStateId_idx" ON "MemoryPrivacyReview"("lineageStateId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryPrivacyReview_articleId_lineageStateId_generation_key" ON "MemoryPrivacyReview"("articleId", "lineageStateId", "generation");

-- CreateIndex
CREATE INDEX "ApiKey_agentPrincipalId_idx" ON "ApiKey"("agentPrincipalId");

-- CreateIndex
CREATE INDEX "Article_recallQuarantinedAt_idx" ON "Article"("recallQuarantinedAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- AddForeignKey
ALTER TABLE "MemoryCapture" ADD CONSTRAINT "MemoryCapture_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_sourceCaptureId_fkey" FOREIGN KEY ("sourceCaptureId") REFERENCES "MemoryCapture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryCandidate" ADD CONSTRAINT "MemoryCandidate_promotedArticleId_fkey" FOREIGN KEY ("promotedArticleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleRecallEnrichment" ADD CONSTRAINT "ArticleRecallEnrichment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRetrievalStat" ADD CONSTRAINT "MemoryRetrievalStat_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRetrievalStat" ADD CONSTRAINT "MemoryRetrievalStat_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "MemoryCapture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRetrievalStat" ADD CONSTRAINT "MemoryRetrievalStat_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "MemoryCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRetrievalStat" ADD CONSTRAINT "MemoryRetrievalStat_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryLineageState" ADD CONSTRAINT "MemoryLineageState_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProvenanceEdge" ADD CONSTRAINT "MemoryProvenanceEdge_lineageStateId_fkey" FOREIGN KEY ("lineageStateId") REFERENCES "MemoryLineageState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProvenanceEdge" ADD CONSTRAINT "MemoryProvenanceEdge_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "MemoryCapture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProvenanceEdge" ADD CONSTRAINT "MemoryProvenanceEdge_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "MemoryCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProvenanceEdge" ADD CONSTRAINT "MemoryProvenanceEdge_enrichmentArticleId_fkey" FOREIGN KEY ("enrichmentArticleId") REFERENCES "ArticleRecallEnrichment"("articleId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProvenanceEdge" ADD CONSTRAINT "MemoryProvenanceEdge_retrievalStatId_fkey" FOREIGN KEY ("retrievalStatId") REFERENCES "MemoryRetrievalStat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProvenanceEdge" ADD CONSTRAINT "MemoryProvenanceEdge_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryTombstone" ADD CONSTRAINT "MemoryTombstone_lineageStateId_fkey" FOREIGN KEY ("lineageStateId") REFERENCES "MemoryLineageState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryTombstone" ADD CONSTRAINT "MemoryTombstone_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryDurableJob" ADD CONSTRAINT "MemoryDurableJob_lineageStateId_fkey" FOREIGN KEY ("lineageStateId") REFERENCES "MemoryLineageState"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryDurableJob" ADD CONSTRAINT "MemoryDurableJob_agentPrincipalId_fkey" FOREIGN KEY ("agentPrincipalId") REFERENCES "MemoryAgentPrincipal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryPrivacyReview" ADD CONSTRAINT "MemoryPrivacyReview_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryPrivacyReview" ADD CONSTRAINT "MemoryPrivacyReview_lineageStateId_fkey" FOREIGN KEY ("lineageStateId") REFERENCES "MemoryLineageState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase A invariants that Prisma cannot express. These constraints keep the
-- disabled-by-default foundation safe even when a future write path bypasses
-- the HTTP handlers.
ALTER TABLE "Article"
  ADD CONSTRAINT "Article_memoryRevocationGeneration_nonnegative"
    CHECK ("memoryRevocationGeneration" >= 0) NOT VALID,
  ADD CONSTRAINT "Article_recallQuarantine_reason"
    CHECK ("recallQuarantinedAt" IS NULL OR length(trim(coalesce("recallQuarantineReason", ''))) > 0) NOT VALID;

ALTER TABLE "MemoryAgentPrincipal"
  ADD CONSTRAINT "MemoryAgentPrincipal_privateScopeTag_private"
    CHECK (length(trim("privateScopeTag")) > 0 AND "privateScopeTag" <> '*'),
  ADD CONSTRAINT "MemoryAgentPrincipal_revocationGeneration_nonnegative"
    CHECK ("revocationGeneration" >= 0),
  ADD CONSTRAINT "MemoryAgentPrincipal_status_timestamp"
    CHECK (
      ("status" = 'ACTIVE' AND "revokedAt" IS NULL)
      OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
    );

ALTER TABLE "MemoryCapture"
  ADD CONSTRAINT "MemoryCapture_hmac_contract"
    CHECK (
      "hmacAlgorithm" = 'HMAC-SHA-256'
      AND "dedupeKeyVersion" > 0
      AND "sourceSessionKeyVersion" > 0
      AND (("sourceRunHash" IS NULL) = ("sourceRunKeyVersion" IS NULL))
      AND ("sourceRunKeyVersion" IS NULL OR "sourceRunKeyVersion" > 0)
    ),
  ADD CONSTRAINT "MemoryCapture_private_scope"
    CHECK (
      length(trim("privateScopeTag")) > 0
      AND "privateScopeTag" <> '*'
      AND cardinality("restrictedTags") = 1
      AND "restrictedTags"[1] = "privateScopeTag"
    ),
  ADD CONSTRAINT "MemoryCapture_bounded_content"
    CHECK (
      octet_length("userText") BETWEEN 1 AND 12000
      AND octet_length("assistantText") BETWEEN 1 AND 12000
      AND octet_length("userText") + octet_length("assistantText") <= 20000
    ),
  ADD CONSTRAINT "MemoryCapture_counters_nonnegative"
    CHECK ("occurrenceCount" > 0 AND "attemptCount" >= 0),
  ADD CONSTRAINT "MemoryCapture_expiry_after_creation"
    CHECK (
      "expiresAt" > "createdAt"
      AND "expiresAt" <= "createdAt" + interval '30 days'
    );

ALTER TABLE "MemoryCandidate"
  ADD CONSTRAINT "MemoryCandidate_hmac_contract"
    CHECK ("hmacAlgorithm" = 'HMAC-SHA-256' AND "dedupeKeyVersion" > 0),
  ADD CONSTRAINT "MemoryCandidate_private_scope"
    CHECK (
      length(trim("privateScopeTag")) > 0
      AND "privateScopeTag" <> '*'
      AND cardinality("restrictedTags") = 1
      AND "restrictedTags"[1] = "privateScopeTag"
    ),
  ADD CONSTRAINT "MemoryCandidate_counters_nonnegative"
    CHECK (
      "occurrenceCount" > 0
      AND "retrievedCount" >= 0
      AND "injectedCount" >= 0
      AND "explicitGetCount" >= 0
      AND "relevanceSum" >= 0
      AND "distinctSessionCount" >= 0
      AND "distinctDayCount" >= 0
    ),
  ADD CONSTRAINT "MemoryCandidate_expiry_after_creation"
    CHECK ("expiresAt" > "createdAt");

ALTER TABLE "ArticleRecallEnrichment"
  ADD CONSTRAINT "ArticleRecallEnrichment_attemptCount_nonnegative"
    CHECK ("attemptCount" >= 0);

ALTER TABLE "MemoryRetrievalStat"
  ADD CONSTRAINT "MemoryRetrievalStat_relevance_bounded"
    CHECK ("normalizedRelevance" IS NULL OR ("normalizedRelevance" >= 0 AND "normalizedRelevance" <= 1)),
  ADD CONSTRAINT "MemoryRetrievalStat_query_hmac_pair"
    CHECK (("queryCorrelationHash" IS NULL) = ("queryCorrelationKeyVersion" IS NULL)),
  ADD CONSTRAINT "MemoryRetrievalStat_session_hmac_pair"
    CHECK (("sourceSessionHash" IS NULL) = ("sourceSessionKeyVersion" IS NULL)),
  ADD CONSTRAINT "MemoryRetrievalStat_hmac_versions_positive"
    CHECK (
      ("queryCorrelationKeyVersion" IS NULL OR "queryCorrelationKeyVersion" > 0)
      AND ("sourceSessionKeyVersion" IS NULL OR "sourceSessionKeyVersion" > 0)
    ),
  ADD CONSTRAINT "MemoryRetrievalStat_boundedContext_object"
    CHECK (jsonb_typeof("boundedContext") = 'object');

ALTER TABLE "MemoryLineageState"
  ADD CONSTRAINT "MemoryLineageState_generation_nonnegative"
    CHECK ("generation" >= 0),
  ADD CONSTRAINT "MemoryLineageState_kind_principal_ownership"
    CHECK (
      ("kind" = 'SCOPE' AND "agentPrincipalId" IS NULL)
      OR ("kind" <> 'SCOPE' AND "agentPrincipalId" IS NOT NULL)
    ),
  ADD CONSTRAINT "MemoryLineageState_hmac_version"
    CHECK (
      ("kind" NOT IN ('CAPTURE', 'SESSION') AND ("hmacKeyVersion" IS NULL OR "hmacKeyVersion" > 0))
      OR ("kind" IN ('CAPTURE', 'SESSION') AND "hmacKeyVersion" IS NOT NULL AND "hmacKeyVersion" > 0)
    );

ALTER TABLE "MemoryProvenanceEdge"
  ADD CONSTRAINT "MemoryProvenanceEdge_exactly_one_target"
    CHECK (num_nonnulls("captureId", "candidateId", "enrichmentArticleId", "retrievalStatId", "articleId") = 1),
  ADD CONSTRAINT "MemoryProvenanceEdge_source_group_nonempty"
    CHECK (length(trim("sourceGroupId")) > 0),
  ADD CONSTRAINT "MemoryProvenanceEdge_generation_nonnegative"
    CHECK ("generationSnapshot" >= 0);

ALTER TABLE "MemoryTombstone"
  ADD CONSTRAINT "MemoryTombstone_generation_nonnegative"
    CHECK ("generation" > 0),
  ADD CONSTRAINT "MemoryTombstone_expiry_after_creation"
    CHECK ("expiresAt" > "createdAt");

ALTER TABLE "MemoryDurableJob"
  ADD CONSTRAINT "MemoryDurableJob_attempts_bounded"
    CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "attemptCount" <= "maxAttempts"),
  ADD CONSTRAINT "MemoryDurableJob_payload_object"
    CHECK (jsonb_typeof("payload") = 'object');

-- Principal identity is a creation-time decision. Reject every UPDATE that
-- changes the binding, including NULL -> non-NULL and non-NULL -> NULL.
CREATE FUNCTION "prevent_api_key_agent_principal_rebind"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."agentPrincipalId" IS DISTINCT FROM OLD."agentPrincipalId" THEN
    RAISE EXCEPTION 'ApiKey agent principal binding is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ApiKey_agentPrincipalId_immutable"
BEFORE UPDATE OF "agentPrincipalId" ON "ApiKey"
FOR EACH ROW
EXECUTE FUNCTION "prevent_api_key_agent_principal_rebind"();

-- Changing a principal's private scope would silently move its historic
-- lineage. Create a new principal instead.
CREATE FUNCTION "prevent_memory_principal_scope_rebind"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."privateScopeTag" IS DISTINCT FROM OLD."privateScopeTag" THEN
    RAISE EXCEPTION 'MemoryAgentPrincipal private scope is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryAgentPrincipal_privateScopeTag_immutable"
BEFORE UPDATE OF "privateScopeTag" ON "MemoryAgentPrincipal"
FOR EACH ROW
EXECUTE FUNCTION "prevent_memory_principal_scope_rebind"();

-- Capture and candidate identity is derived from the authenticated principal,
-- never from a worker payload. Keep the redundant scope columns because they
-- make scoped queries cheap, but verify them against the principal at the
-- database boundary and make the inherited identity immutable.
CREATE FUNCTION "validate_memory_capture_identity_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal_scope text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."agentPrincipalId" IS DISTINCT FROM OLD."agentPrincipalId"
    OR NEW."privateScopeTag" IS DISTINCT FROM OLD."privateScopeTag"
    OR NEW."restrictedTags" IS DISTINCT FROM OLD."restrictedTags"
  ) THEN
    RAISE EXCEPTION 'MemoryCapture principal and private scope are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT "privateScopeTag"
  INTO principal_scope
  FROM "MemoryAgentPrincipal"
  WHERE id = NEW."agentPrincipalId";

  IF principal_scope IS NULL OR principal_scope IS DISTINCT FROM NEW."privateScopeTag" THEN
    RAISE EXCEPTION 'MemoryCapture private scope must match its principal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryCapture_identity_scope_guard"
BEFORE INSERT OR UPDATE OF "agentPrincipalId", "privateScopeTag", "restrictedTags"
ON "MemoryCapture"
FOR EACH ROW
EXECUTE FUNCTION "validate_memory_capture_identity_scope"();

CREATE FUNCTION "validate_memory_candidate_identity_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  principal_scope text;
  capture_principal_id text;
  capture_scope text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."sourceCaptureId" IS DISTINCT FROM OLD."sourceCaptureId"
    AND OLD.status <> 'QUARANTINED'
  THEN
    RAISE EXCEPTION 'MemoryCandidate source capture is immutable until quarantine'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."agentPrincipalId" IS DISTINCT FROM OLD."agentPrincipalId"
    OR NEW."privateScopeTag" IS DISTINCT FROM OLD."privateScopeTag"
    OR NEW."restrictedTags" IS DISTINCT FROM OLD."restrictedTags"
  ) THEN
    RAISE EXCEPTION 'MemoryCandidate principal and private scope are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT "privateScopeTag"
  INTO principal_scope
  FROM "MemoryAgentPrincipal"
  WHERE id = NEW."agentPrincipalId";

  IF principal_scope IS NULL OR principal_scope IS DISTINCT FROM NEW."privateScopeTag" THEN
    RAISE EXCEPTION 'MemoryCandidate private scope must match its principal'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."sourceCaptureId" IS NOT NULL THEN
    SELECT "agentPrincipalId", "privateScopeTag"
    INTO capture_principal_id, capture_scope
    FROM "MemoryCapture"
    WHERE id = NEW."sourceCaptureId";

    IF capture_principal_id IS NULL
      OR capture_principal_id IS DISTINCT FROM NEW."agentPrincipalId"
      OR capture_scope IS DISTINCT FROM NEW."privateScopeTag"
    THEN
      RAISE EXCEPTION 'MemoryCandidate source capture must share principal and private scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MemoryCandidate_identity_scope_guard"
BEFORE INSERT OR UPDATE OF "agentPrincipalId", "privateScopeTag", "restrictedTags", "sourceCaptureId"
ON "MemoryCandidate"
FOR EACH ROW
EXECUTE FUNCTION "validate_memory_candidate_identity_scope"();

-- A raw capture is privacy-sensitive source material. The only safe direct
-- deletion path first quarantines every derived candidate; otherwise the
-- source relation could be nulled by the foreign key while an active derived
-- artifact survives.
CREATE FUNCTION "prevent_active_memory_capture_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryCandidate" candidate
    WHERE candidate."sourceCaptureId" = OLD.id
      AND candidate.status <> 'QUARANTINED'
  ) THEN
    RAISE EXCEPTION 'MemoryCapture cannot be deleted while derived candidates are active'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "MemoryCapture_active_candidate_delete_guard"
BEFORE DELETE ON "MemoryCapture"
FOR EACH ROW
EXECUTE FUNCTION "prevent_active_memory_capture_delete"();

-- Every capture source group must contain the exact current principal, scope,
-- session, and capture lineage recorded on the capture row. Extra lineage
-- (for example a future consent edge) is permitted only when it is active and
-- bound to the same principal. This turns the source group into canonical
-- revocation authority instead of trusting whichever CAPTURE edge was added.
CREATE FUNCTION "assert_memory_capture_has_source"(capture_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryCapture" capture
    WHERE capture.id = capture_id
      AND (
        NOT EXISTS (
          SELECT 1
          FROM "MemoryAgentPrincipal" principal
          WHERE principal.id = capture."agentPrincipalId"
            AND principal.status = 'ACTIVE'
            AND principal."revokedAt" IS NULL
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "MemoryProvenanceEdge" edge
          WHERE edge."captureId" = capture.id
        )
        OR EXISTS (
          SELECT edge."sourceGroupId"
          FROM "MemoryProvenanceEdge" edge
          JOIN "MemoryLineageState" lineage
            ON lineage.id = edge."lineageStateId"
          WHERE edge."captureId" = capture.id
          GROUP BY edge."sourceGroupId"
          HAVING NOT (
            bool_and(
              lineage."revokedAt" IS NULL
              AND lineage.generation = edge."generationSnapshot"
              AND (
                (
                  lineage.kind = 'SCOPE'
                  AND lineage."agentPrincipalId" IS NULL
                  AND lineage."subjectHash" = 'scope:' || capture."privateScopeTag"
                )
                OR (
                  lineage.kind <> 'SCOPE'
                  AND lineage."agentPrincipalId" = capture."agentPrincipalId"
                )
              )
            )
            AND bool_or(
              lineage.kind = 'PRINCIPAL'
              AND lineage."subjectHash" = 'principal:' || capture."agentPrincipalId"
              AND lineage."agentPrincipalId" = capture."agentPrincipalId"
              AND lineage."hmacKeyVersion" IS NULL
            )
            AND bool_or(
              lineage.kind = 'SCOPE'
              AND lineage."subjectHash" = 'scope:' || capture."privateScopeTag"
              AND lineage."agentPrincipalId" IS NULL
              AND lineage."hmacKeyVersion" IS NULL
            )
            AND bool_or(
              lineage.kind = 'SESSION'
              AND lineage."subjectHash" = capture."sourceSessionHash"
              AND lineage."hmacKeyVersion" = capture."sourceSessionKeyVersion"
              AND lineage."agentPrincipalId" = capture."agentPrincipalId"
            )
            AND bool_or(
              lineage.kind = 'CAPTURE'
              AND lineage."subjectHash" = capture."dedupeKey"
              AND lineage."hmacKeyVersion" = capture."dedupeKeyVersion"
              AND lineage."agentPrincipalId" = capture."agentPrincipalId"
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'MemoryCapture requires complete canonical active provenance'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "validate_memory_capture_source"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_memory_capture_has_source"(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "MemoryCapture_source_required"
AFTER INSERT OR UPDATE OF "dedupeKey", "dedupeKeyVersion", "agentPrincipalId", "privateScopeTag", "sourceSessionHash", "sourceSessionKeyVersion"
ON "MemoryCapture"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_memory_capture_source"();

-- Every candidate must carry one or more complete, currently authorized
-- provenance groups. A raw capture relation is useful for processing, but is
-- not itself authority: revocation and cleanup traverse provenance edges.
-- The deferred check supports Prisma nested writes and lets cleanup remove an
-- inactive group and null a deleted raw-capture relation in one transaction.
CREATE FUNCTION "memory_candidate_source_is_valid"(candidate_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM "MemoryCandidate" candidate
    WHERE candidate.id = candidate_id
      AND (
        NOT EXISTS (
          SELECT 1
          FROM "MemoryAgentPrincipal" principal
          WHERE principal.id = candidate."agentPrincipalId"
            AND principal.status = 'ACTIVE'
            AND principal."revokedAt" IS NULL
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "MemoryProvenanceEdge" edge
          WHERE edge."candidateId" = candidate.id
        )
        OR (
          candidate."sourceCaptureId" IS NOT NULL
          AND NOT EXISTS (
            -- At least one candidate source group must inherit every edge
            -- from one complete source-capture group, including its canonical
            -- CAPTURE lineage. This makes capture/session revocation traverse
            -- every candidate that claims the raw capture as a source.
            SELECT 1
            FROM "MemoryProvenanceEdge" inherited_capture_edge
            JOIN "MemoryLineageState" capture_lineage
              ON capture_lineage.id = inherited_capture_edge."lineageStateId"
            JOIN "MemoryProvenanceEdge" source_capture_edge
              ON source_capture_edge."captureId" = candidate."sourceCaptureId"
              AND source_capture_edge."lineageStateId" = inherited_capture_edge."lineageStateId"
              AND source_capture_edge."generationSnapshot" = inherited_capture_edge."generationSnapshot"
            WHERE inherited_capture_edge."candidateId" = candidate.id
              AND capture_lineage.kind = 'CAPTURE'
              AND NOT EXISTS (
                SELECT 1
                FROM "MemoryProvenanceEdge" source_edge
                WHERE source_edge."captureId" = candidate."sourceCaptureId"
                  AND source_edge."sourceGroupId" = source_capture_edge."sourceGroupId"
                  AND NOT EXISTS (
                    SELECT 1
                    FROM "MemoryProvenanceEdge" inherited_edge
                    WHERE inherited_edge."candidateId" = candidate.id
                      AND inherited_edge."sourceGroupId" = inherited_capture_edge."sourceGroupId"
                      AND inherited_edge."lineageStateId" = source_edge."lineageStateId"
                      AND inherited_edge."generationSnapshot" = source_edge."generationSnapshot"
                  )
              )
          )
        )
        OR EXISTS (
          SELECT edge."sourceGroupId"
          FROM "MemoryProvenanceEdge" edge
          JOIN "MemoryLineageState" lineage
            ON lineage.id = edge."lineageStateId"
          WHERE edge."candidateId" = candidate.id
          GROUP BY edge."sourceGroupId"
          HAVING NOT (
            bool_and(
              lineage."revokedAt" IS NULL
              AND lineage.generation = edge."generationSnapshot"
              AND (
                (
                  lineage.kind = 'SCOPE'
                  AND lineage."subjectHash" = 'scope:' || candidate."privateScopeTag"
                )
                OR (
                  lineage.kind <> 'SCOPE'
                  AND lineage."agentPrincipalId" = candidate."agentPrincipalId"
                )
              )
            )
            AND bool_or(
              lineage.kind = 'PRINCIPAL'
              AND lineage."agentPrincipalId" = candidate."agentPrincipalId"
              AND lineage."subjectHash" = 'principal:' || candidate."agentPrincipalId"
            )
            AND bool_or(
              lineage.kind = 'SCOPE'
              AND lineage."subjectHash" = 'scope:' || candidate."privateScopeTag"
            )
          )
        )
      )
  );
$$;

CREATE FUNCTION "assert_memory_candidate_has_source"(candidate_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT "memory_candidate_source_is_valid"(candidate_id) THEN
    RAISE EXCEPTION 'MemoryCandidate requires complete active principal-scoped provenance'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "validate_memory_candidate_source"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_memory_candidate_has_source"(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "MemoryCandidate_source_required"
AFTER INSERT OR UPDATE OF "sourceCaptureId" ON "MemoryCandidate"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_memory_candidate_source"();

-- Revalidate all candidates that inherit the changed capture source group in
-- one set-based query. The current CAPTURE edge identifies ordinary group
-- changes; the changed edge parameters preserve that identity when the
-- canonical CAPTURE edge itself was deleted or moved before deferred checks.
CREATE FUNCTION "assert_memory_capture_group_candidates_have_source"(
  capture_id text,
  source_group_id text,
  changed_lineage_state_id text,
  changed_generation_snapshot integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MemoryCandidate" candidate
    WHERE candidate."sourceCaptureId" = capture_id
      AND (
        EXISTS (
          SELECT 1
          FROM "MemoryProvenanceEdge" source_anchor
          JOIN "MemoryLineageState" anchor_lineage
            ON anchor_lineage.id = source_anchor."lineageStateId"
          JOIN "MemoryProvenanceEdge" candidate_anchor
            ON candidate_anchor."candidateId" = candidate.id
            AND candidate_anchor."lineageStateId" = source_anchor."lineageStateId"
            AND candidate_anchor."generationSnapshot" = source_anchor."generationSnapshot"
          WHERE source_anchor."captureId" = capture_id
            AND source_anchor."sourceGroupId" = source_group_id
            AND anchor_lineage.kind = 'CAPTURE'
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryLineageState" changed_lineage
          JOIN "MemoryProvenanceEdge" candidate_anchor
            ON candidate_anchor."candidateId" = candidate.id
            AND candidate_anchor."lineageStateId" = changed_lineage.id
            AND candidate_anchor."generationSnapshot" = changed_generation_snapshot
          WHERE changed_lineage.id = changed_lineage_state_id
            AND changed_lineage.kind = 'CAPTURE'
        )
      )
      AND NOT "memory_candidate_source_is_valid"(candidate.id)
  ) THEN
    RAISE EXCEPTION 'MemoryCandidate requires complete active principal-scoped provenance'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "validate_memory_candidate_source_edge"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."candidateId" IS NOT NULL THEN
    PERFORM "assert_memory_candidate_has_source"(OLD."candidateId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."candidateId" IS NOT NULL THEN
    PERFORM "assert_memory_candidate_has_source"(NEW."candidateId");
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."captureId" IS NOT NULL THEN
    PERFORM "assert_memory_capture_has_source"(OLD."captureId");
    PERFORM "assert_memory_capture_group_candidates_have_source"(
      OLD."captureId",
      OLD."sourceGroupId",
      OLD."lineageStateId",
      OLD."generationSnapshot"
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."captureId" IS NOT NULL THEN
    PERFORM "assert_memory_capture_has_source"(NEW."captureId");
    PERFORM "assert_memory_capture_group_candidates_have_source"(
      NEW."captureId",
      NEW."sourceGroupId",
      NEW."lineageStateId",
      NEW."generationSnapshot"
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "MemoryProvenanceEdge_candidate_source_required"
AFTER INSERT OR UPDATE OR DELETE ON "MemoryProvenanceEdge"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_memory_candidate_source_edge"();
