import {
  MemoryCaptureStatus,
  MemoryJobStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SchedulerJobDefinition } from "@/lib/memory/scheduler";
import { quarantineLineage } from "./lifecycle";
import { MemoryCaptureError, withSerializableRetry } from "./repository";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const JOB_LEASE_MS = 60_000;

type LeasedMemoryJob = {
  id: string;
  kind: string;
  payload: Prisma.JsonValue;
  lineageStateId: string | null;
  attemptCount: number;
  maxAttempts: number;
};

type ProvenanceTargetField =
  | "captureId"
  | "candidateId"
  | "enrichmentArticleId"
  | "retrievalStatId"
  | "articleId";

type ProvenanceTarget = { field: ProvenanceTargetField; id: string };

type CleanupProvenanceEdge = {
  id: string;
  sourceGroupId: string;
  lineageStateId: string;
  generationSnapshot: number;
  captureId: string | null;
  candidateId: string | null;
  enrichmentArticleId: string | null;
  retrievalStatId: string | null;
  articleId: string | null;
  lineageState: {
    generation: number;
    revokedAt: Date | null;
  };
};

export type MemoryMaintenanceSummary = {
  claimed: number;
  succeeded: number;
  rescheduled: number;
  failed: number;
};

/**
 * Lease and execute durable privacy/expiry jobs. Deliberately independent of
 * the capture-ingestion flag: disabling new memory must never strand retained
 * private data or stop revocation cleanup.
 */
export async function runMemoryMaintenanceBatch(options: {
  workerId: string;
  limit?: number;
  now?: Date;
}): Promise<MemoryMaintenanceSummary> {
  const workerId = options.workerId.trim();
  if (!workerId || workerId.length > 128) {
    throw new MemoryCaptureError("Maintenance worker ID is invalid", 400);
  }
  const limit = normalizeBatchSize(options.limit);
  const now = options.now ?? new Date();
  const jobs = await leaseDueJobs(workerId, limit, now);
  const summary: MemoryMaintenanceSummary = {
    claimed: jobs.length,
    succeeded: 0,
    rescheduled: 0,
    failed: 0,
  };

  for (const job of jobs) {
    try {
      const outcome = await processLeasedJob(job, workerId, now);
      summary[outcome] += 1;
    } catch (error) {
      await releaseFailedJob(job, workerId, now, error);
      summary.failed += 1;
    }
  }
  return summary;
}

export function createDurableMemoryMaintenanceJob(
  intervalMs = 60_000,
  batchSize = DEFAULT_BATCH_SIZE,
): SchedulerJobDefinition {
  return {
    id: "memory.durable-maintenance",
    name: "Durable automatic-memory expiry and privacy cleanup",
    intervalMs,
    runOnStart: true,
    run: async ({ startedAt, runCount }) => {
      await runMemoryMaintenanceBatch({
        workerId: `local-scheduler:${process.pid}:${startedAt}:${runCount}`,
        limit: batchSize,
      });
    },
  };
}

async function leaseDueJobs(
  workerId: string,
  limit: number,
  now: Date,
): Promise<LeasedMemoryJob[]> {
  const leaseExpiresAt = new Date(now.getTime() + JOB_LEASE_MS);
  return prisma.$transaction(
    (tx) => tx.$queryRaw<LeasedMemoryJob[]>(Prisma.sql`
      WITH due AS (
        SELECT job.id
        FROM "MemoryDurableJob" job
        WHERE job."nextAttemptAt" <= ${now}
          AND job."attemptCount" < job."maxAttempts"
          AND (
            job.status = 'PENDING'
            OR (job.status = 'LEASED' AND job."leaseExpiresAt" <= ${now})
          )
        ORDER BY job."nextAttemptAt", job.id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "MemoryDurableJob" job
      SET status = 'LEASED',
          "leaseOwner" = ${workerId},
          "leaseExpiresAt" = ${leaseExpiresAt},
          "attemptCount" = job."attemptCount" + 1,
          "updatedAt" = ${now}
      FROM due
      WHERE job.id = due.id
      RETURNING job.id, job.kind, job.payload, job."lineageStateId",
                job."attemptCount", job."maxAttempts"
    `),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

async function processLeasedJob(
  job: LeasedMemoryJob,
  workerId: string,
  now: Date,
): Promise<"succeeded" | "rescheduled"> {
  switch (job.kind) {
    case "memory_capture_expiry":
      return processCaptureExpiry(job, workerId, now);
    case "memory_privacy_cleanup":
      return processPrivacyCleanup(job, workerId, now);
    default:
      throw new MemoryCaptureError("Unsupported durable memory job kind", 409);
  }
}

async function processCaptureExpiry(
  job: LeasedMemoryJob,
  workerId: string,
  now: Date,
): Promise<"succeeded" | "rescheduled"> {
  const captureId = readPayloadId(job.payload, "captureId");
  if (!job.lineageStateId) {
    throw new MemoryCaptureError("Capture expiry job has no lineage", 409);
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockLineage(tx, job.lineageStateId!);
        const captures = await tx.$queryRaw<
          Array<{
            id: string;
            expiresAt: Date;
            status: MemoryCaptureStatus;
            quarantinedAt: Date | null;
          }>
        >(Prisma.sql`
          SELECT capture.id, capture."expiresAt", capture.status, capture."quarantinedAt"
          FROM "MemoryCapture" capture
          WHERE capture.id = ${captureId}
          FOR UPDATE
        `);
        const capture = captures[0];
        if (!capture) {
          await completeLeasedJob(tx, job.id, workerId, now);
          return "succeeded" as const;
        }
        if (capture.expiresAt.getTime() > now.getTime()) {
          await rescheduleLeasedJob(
            tx,
            job.id,
            workerId,
            capture.expiresAt,
            now,
          );
          return "rescheduled" as const;
        }

        await quarantineLineage(tx, job.lineageStateId!, "expired");
        await tx.memoryCapture.updateMany({
          where: { id: capture.id },
          data: {
            status: MemoryCaptureStatus.EXPIRED,
            quarantinedAt: capture.quarantinedAt ?? now,
          },
        });
        await completeLeasedJob(tx, job.id, workerId, now);
        return "succeeded" as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function processPrivacyCleanup(
  job: LeasedMemoryJob,
  workerId: string,
  now: Date,
): Promise<"succeeded"> {
  if (!job.lineageStateId) {
    throw new MemoryCaptureError("Privacy cleanup job has no lineage", 409);
  }
  readPayloadId(job.payload, "lineageStateId", job.lineageStateId);
  const generation = readPayloadPositiveInt(job.payload, "generation");

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const affectedEdges = await tx.memoryProvenanceEdge.findMany({
          where: { lineageStateId: job.lineageStateId! },
          select: {
            captureId: true,
            candidateId: true,
            enrichmentArticleId: true,
            retrievalStatId: true,
            articleId: true,
          },
        });
        const targets = collectProvenanceTargets(affectedEdges);
        if (targets.length > 0) {
          const allEdges = await tx.memoryProvenanceEdge.findMany({
            where: { OR: targets.map(targetWhere) },
            include: {
              lineageState: {
                select: { generation: true, revokedAt: true },
              },
            },
          });
          const lineageIds = [
            ...new Set([
              job.lineageStateId!,
              ...allEdges.map(({ lineageStateId }) => lineageStateId),
            ]),
          ];
          await lockLineagesForCleanup(tx, lineageIds);
          for (const target of targets) await lockArtifactTarget(tx, target);

          for (const target of targets) {
            const targetEdges = allEdges.filter((edge) => edgeMatchesTarget(edge, target));
            const activeGroups = activeProvenanceGroups(targetEdges);

            // Raw captures and retrieval correlations are source-specific and
            // must be removed on any source revocation. Derived artifacts may
            // survive only when a separate complete source group remains.
            if (target.field === "captureId") {
              await tx.memoryCapture.deleteMany({ where: { id: target.id } });
            } else if (target.field === "retrievalStatId") {
              await tx.memoryRetrievalStat.deleteMany({ where: { id: target.id } });
            } else if (target.field === "candidateId") {
              if (activeGroups.size === 0) {
                await tx.memoryCandidate.deleteMany({ where: { id: target.id } });
              } else {
                await removeInactiveProvenanceGroups(tx, target, targetEdges, activeGroups);
              }
            } else if (target.field === "enrichmentArticleId") {
              if (activeGroups.size === 0) {
                await tx.articleRecallEnrichment.deleteMany({
                  where: { articleId: target.id },
                });
              } else {
                await removeInactiveProvenanceGroups(tx, target, targetEdges, activeGroups);
              }
            } else {
              const article = await tx.article.findUnique({
                where: { id: target.id },
                select: { status: true },
              });
              if (article?.status === "draft" && activeGroups.size === 0) {
                await tx.article.delete({ where: { id: target.id } });
              } else if (article?.status === "draft") {
                await removeInactiveProvenanceGroups(tx, target, targetEdges, activeGroups);
                await tx.memoryPrivacyReview.upsert({
                  where: {
                    articleId_lineageStateId_generation: {
                      articleId: target.id,
                      lineageStateId: job.lineageStateId!,
                      generation,
                    },
                  },
                  create: {
                    articleId: target.id,
                    lineageStateId: job.lineageStateId!,
                    generation,
                    reasonCode: "independent_provenance_requires_resynthesis",
                  },
                  update: {},
                });
              }
              // Reviewed/published articles retain full provenance for their
              // existing explicit privacy-review decision.
            }
          }
        }

        await completeLeasedJob(tx, job.id, workerId, now);
        return "succeeded" as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

const TARGET_FIELDS: ProvenanceTargetField[] = [
  "captureId",
  "candidateId",
  "enrichmentArticleId",
  "retrievalStatId",
  "articleId",
];

function collectProvenanceTargets(
  edges: Array<Pick<CleanupProvenanceEdge, ProvenanceTargetField>>,
): ProvenanceTarget[] {
  const targets = new Map<string, ProvenanceTarget>();
  for (const edge of edges) {
    for (const field of TARGET_FIELDS) {
      const id = edge[field];
      if (id) targets.set(`${field}:${id}`, { field, id });
    }
  }
  return [...targets.values()].sort(
    (left, right) =>
      TARGET_FIELDS.indexOf(left.field) - TARGET_FIELDS.indexOf(right.field) ||
      left.id.localeCompare(right.id),
  );
}

function targetWhere(target: ProvenanceTarget): Prisma.MemoryProvenanceEdgeWhereInput {
  return { [target.field]: target.id };
}

function edgeMatchesTarget(
  edge: CleanupProvenanceEdge,
  target: ProvenanceTarget,
): boolean {
  return edge[target.field] === target.id;
}

function activeProvenanceGroups(edges: CleanupProvenanceEdge[]): Set<string> {
  const groups = new Map<string, CleanupProvenanceEdge[]>();
  for (const edge of edges) {
    const group = groups.get(edge.sourceGroupId) ?? [];
    group.push(edge);
    groups.set(edge.sourceGroupId, group);
  }
  return new Set(
    [...groups.entries()]
      .filter(([, group]) =>
        group.every(
          (edge) =>
            edge.lineageState.revokedAt === null &&
            edge.lineageState.generation === edge.generationSnapshot,
        ),
      )
      .map(([sourceGroupId]) => sourceGroupId),
  );
}

async function removeInactiveProvenanceGroups(
  tx: Prisma.TransactionClient,
  target: ProvenanceTarget,
  edges: CleanupProvenanceEdge[],
  activeGroups: Set<string>,
): Promise<void> {
  const inactiveGroups = [
    ...new Set(
      edges
        .map(({ sourceGroupId }) => sourceGroupId)
        .filter((sourceGroupId) => !activeGroups.has(sourceGroupId)),
    ),
  ];
  if (inactiveGroups.length === 0) return;
  await tx.memoryProvenanceEdge.deleteMany({
    where: {
      ...targetWhere(target),
      sourceGroupId: { in: inactiveGroups },
    },
  });
}

async function lockLineagesForCleanup(
  tx: Prisma.TransactionClient,
  lineageIds: string[],
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT lineage.id
    FROM "MemoryLineageState" lineage
    WHERE lineage.id IN (${Prisma.join(lineageIds)})
    ORDER BY lineage.kind::text, lineage."subjectHash", lineage.id
    FOR UPDATE
  `);
  if (rows.length !== lineageIds.length) {
    throw new MemoryCaptureError("Memory provenance lineage is incomplete", 409);
  }
}

async function lockArtifactTarget(
  tx: Prisma.TransactionClient,
  target: ProvenanceTarget,
): Promise<void> {
  const tableAndColumn: Record<ProvenanceTargetField, [string, string]> = {
    captureId: ["MemoryCapture", "id"],
    candidateId: ["MemoryCandidate", "id"],
    enrichmentArticleId: ["ArticleRecallEnrichment", "articleId"],
    retrievalStatId: ["MemoryRetrievalStat", "id"],
    articleId: ["Article", "id"],
  };
  const [table, column] = tableAndColumn[target.field];
  await tx.$queryRaw(Prisma.sql`
    SELECT artifact.${Prisma.raw(`"${column}"`)}
    FROM ${Prisma.raw(`"${table}"`)} artifact
    WHERE artifact.${Prisma.raw(`"${column}"`)} = ${target.id}
    FOR UPDATE
  `);
}

async function lockLineage(
  tx: Prisma.TransactionClient,
  lineageStateId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT lineage.id
    FROM "MemoryLineageState" lineage
    WHERE lineage.id = ${lineageStateId}
    FOR UPDATE
  `);
  if (!rows[0]) throw new MemoryCaptureError("Memory lineage not found", 404);
}

async function completeLeasedJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  workerId: string,
  now: Date,
): Promise<void> {
  const updated = await tx.memoryDurableJob.updateMany({
    where: {
      id: jobId,
      status: MemoryJobStatus.LEASED,
      leaseOwner: workerId,
    },
    data: {
      status: MemoryJobStatus.SUCCEEDED,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      lastErrorCode: null,
    },
  });
  if (updated.count !== 1) {
    throw new MemoryCaptureError("Durable memory job lease was lost", 409);
  }
}

async function rescheduleLeasedJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  workerId: string,
  nextAttemptAt: Date,
  now: Date,
): Promise<void> {
  const updated = await tx.memoryDurableJob.updateMany({
    where: {
      id: jobId,
      status: MemoryJobStatus.LEASED,
      leaseOwner: workerId,
    },
    data: {
      status: MemoryJobStatus.PENDING,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt,
      completedAt: null,
      lastErrorCode: null,
      updatedAt: now,
    },
  });
  if (updated.count !== 1) {
    throw new MemoryCaptureError("Durable memory job lease was lost", 409);
  }
}

async function releaseFailedJob(
  job: LeasedMemoryJob,
  workerId: string,
  now: Date,
  error: unknown,
): Promise<void> {
  const exhausted = job.attemptCount >= job.maxAttempts;
  const backoffMs = Math.min(60 * 60_000, 2 ** Math.min(job.attemptCount, 10) * 1_000);
  await prisma.memoryDurableJob.updateMany({
    where: {
      id: job.id,
      status: MemoryJobStatus.LEASED,
      leaseOwner: workerId,
    },
    data: {
      status: exhausted ? MemoryJobStatus.FAILED : MemoryJobStatus.PENDING,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(now.getTime() + backoffMs),
      lastErrorCode: classifyJobError(error),
    },
  });
}

function readPayloadId(
  payload: Prisma.JsonValue,
  field: string,
  expected?: string,
): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MemoryCaptureError("Durable memory job payload is invalid", 409);
  }
  const value = (payload as Prisma.JsonObject)[field];
  if (typeof value !== "string" || !value || (expected && value !== expected)) {
    throw new MemoryCaptureError("Durable memory job payload is invalid", 409);
  }
  return value;
}

function readPayloadPositiveInt(payload: Prisma.JsonValue, field: string): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MemoryCaptureError("Durable memory job payload is invalid", 409);
  }
  const value = (payload as Prisma.JsonObject)[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MemoryCaptureError("Durable memory job payload is invalid", 409);
  }
  return value;
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new MemoryCaptureError("Maintenance batch size is invalid", 400);
  }
  return value;
}

function classifyJobError(error: unknown): string {
  if (error instanceof MemoryCaptureError) return `memory_${error.status}`;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `prisma_${error.code}`.slice(0, 64);
  }
  return "unexpected_error";
}
