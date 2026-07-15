import {
  MemoryLineageKind,
  MemoryPrincipalStatus,
  MemoryPrivacyReviewStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { digestWithAllKeys, type CaptureHmacKeyring } from "./crypto";
import { MemoryCaptureError, withSerializableRetry } from "./repository";

const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type MemoryRevocationReason =
  | "capture_deleted"
  | "principal_revoked"
  | "session_deleted"
  | "scope_deleted"
  | "consent_revoked"
  | "expired";

export async function createMemoryAgentPrincipal(input: {
  name: string;
  privateScopeTag: string;
}) {
  const name = input.name.trim();
  const privateScopeTag = input.privateScopeTag.trim();
  if (!name || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    throw new MemoryCaptureError("Principal name is invalid", 400);
  }
  if (!/^[a-z0-9-]+$/.test(privateScopeTag) || privateScopeTag === "*") {
    throw new MemoryCaptureError("A concrete private restricted scope is required", 400);
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const scope = await tx.$queryRaw<Array<{ tag: string }>>(Prisma.sql`
          SELECT "tag"
          FROM "RestrictedScope"
          WHERE "tag" = ${privateScopeTag}
          FOR KEY SHARE
        `);
        if (!scope[0]) throw new MemoryCaptureError("Restricted scope not found", 404);

        const principal = await tx.memoryAgentPrincipal.create({
          data: { name, privateScopeTag },
        });
        await tx.memoryLineageState.createMany({
          data: [
            {
              kind: MemoryLineageKind.PRINCIPAL,
              subjectHash: `principal:${principal.id}`,
              agentPrincipalId: principal.id,
            },
            {
              kind: MemoryLineageKind.SCOPE,
              subjectHash: `scope:${privateScopeTag}`,
            },
          ],
          skipDuplicates: true,
        });
        return principal;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function revokeMemoryAgentPrincipal(
  principalId: string,
  reason: MemoryRevocationReason = "principal_revoked",
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const principalRows = await tx.$queryRaw<
          Array<{ id: string; status: MemoryPrincipalStatus }>
        >(Prisma.sql`
          SELECT "id", "status"
          FROM "MemoryAgentPrincipal"
          WHERE "id" = ${principalId}
          FOR UPDATE
        `);
        const principal = principalRows[0];
        if (!principal) throw new MemoryCaptureError("Memory principal not found", 404);

        const lineage = await getOrCreateLineage(tx, {
          kind: MemoryLineageKind.PRINCIPAL,
          subjectHash: `principal:${principalId}`,
          agentPrincipalId: principalId,
        });
        const generation = await quarantineLineage(tx, lineage.id, reason);
        await tx.memoryAgentPrincipal.update({
          where: { id: principalId },
          data: {
            status: MemoryPrincipalStatus.REVOKED,
            revokedAt: new Date(),
            revocationGeneration: generation,
          },
        });
        return { principalId, generation };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function quarantineMemoryCapture(
  captureId: string,
  reason: MemoryRevocationReason = "capture_deleted",
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ lineageStateId: string }>>(Prisma.sql`
          SELECT e."lineageStateId"
          FROM "MemoryProvenanceEdge" e
          JOIN "MemoryLineageState" l ON l."id" = e."lineageStateId"
          WHERE e."captureId" = ${captureId}
            AND l."kind" = 'CAPTURE'
          FOR UPDATE OF l
        `);
        if (!rows[0]) throw new MemoryCaptureError("Memory capture not found", 404);
        const generation = await quarantineLineage(tx, rows[0].lineageStateId, reason);
        return { captureId, generation };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function revokeMemorySession(input: {
  principalId: string;
  sourceSessionId: string;
  keyring: CaptureHmacKeyring;
}) {
  const digests = digestWithAllKeys(
    input.keyring,
    "session",
    input.principalId,
    [input.sourceSessionId],
  ).sort((left, right) => left.digest.localeCompare(right.digest));
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const principal = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "MemoryAgentPrincipal"
          WHERE "id" = ${input.principalId}
          FOR UPDATE
        `);
        if (!principal[0]) throw new MemoryCaptureError("Memory principal not found", 404);

        const lineages: Array<{ id: string; subjectHash: string }> = [];
        for (const digest of digests) {
          const lineage = await getOrCreateLineage(tx, {
            kind: MemoryLineageKind.SESSION,
            subjectHash: digest.digest,
            hmacKeyVersion: digest.keyVersion,
            agentPrincipalId: input.principalId,
          });
          lineages.push(lineage);
        }
        const generations: number[] = [];
        for (const lineage of lineages) {
          generations.push(
            await quarantineLineage(tx, lineage.id, "session_deleted"),
          );
        }
        return { principalId: input.principalId, generations };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function deleteMemoryRestrictedScope(tag: string) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const scopeRows = await tx.$queryRaw<Array<{ tag: string; isSystem: boolean }>>(Prisma.sql`
          SELECT "tag", "isSystem"
          FROM "RestrictedScope"
          WHERE "tag" = ${tag}
          FOR UPDATE
        `);
        const scope = scopeRows[0];
        if (!scope) throw new MemoryCaptureError("Restricted scope not found", 404);
        if (scope.isSystem) throw new MemoryCaptureError("System scopes cannot be deleted", 400);

        // Match capture's key -> principal -> lineage lock order. The scope row
        // is independent (capture never locks it), while taking lineage first
        // here would create a key/lineage deadlock with concurrent ingestion.
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT key.id
          FROM "ApiKey" key
          LEFT JOIN "MemoryAgentPrincipal" principal
            ON principal.id = key."agentPrincipalId"
          WHERE key."allowedScopes" @> ARRAY[${tag}]::text[]
             OR principal."privateScopeTag" = ${tag}
          ORDER BY key.id
          FOR UPDATE OF key
        `);

        const principals = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "MemoryAgentPrincipal"
          WHERE "privateScopeTag" = ${tag}
          ORDER BY "id"
          FOR UPDATE
        `);

        const lineageTargets = [
          ...principals.map((principal) => ({
            kind: MemoryLineageKind.PRINCIPAL,
            subjectHash: `principal:${principal.id}`,
            agentPrincipalId: principal.id,
          })),
          {
            kind: MemoryLineageKind.SCOPE,
            subjectHash: `scope:${tag}`,
            agentPrincipalId: undefined,
          },
        ].sort(
          (left, right) =>
            left.kind.localeCompare(right.kind) ||
            left.subjectHash.localeCompare(right.subjectHash),
        );

        const revokedLineageIds: string[] = [];
        for (const target of lineageTargets) {
          const lineage = await getOrCreateLineage(tx, target);
          revokedLineageIds.push(lineage.id);
          const generation = await quarantineLineage(tx, lineage.id, "scope_deleted");
          if (target.kind === MemoryLineageKind.PRINCIPAL) {
            await tx.memoryAgentPrincipal.update({
              where: { id: target.agentPrincipalId! },
              data: {
                status: MemoryPrincipalStatus.REVOKED,
                revokedAt: new Date(),
                revocationGeneration: generation,
              },
            });
          }
        }

        // A tagged article is safe only when this transaction revoked a
        // provenance group that actually reaches it. Unrelated provenance is
        // not evidence that the article came from this private scope.
        const blockingArticleCount = await tx.article.count({
          where: {
            restrictedTags: { has: tag },
            memoryProvenanceEdges: {
              none: { lineageStateId: { in: revokedLineageIds } },
            },
          },
        });
        if (blockingArticleCount > 0) {
          throw new MemoryCaptureError(
            `Cannot delete scope while ${blockingArticleCount} unrelated article(s) still use it`,
            409,
          );
        }

        // Credential scope removal is not a privacy deletion. It prevents old
        // keys from continuing to claim authorization for the deleted tag.
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ApiKey"
          SET "allowedScopes" = array_remove("allowedScopes", ${tag})
          WHERE "allowedScopes" @> ARRAY[${tag}]::text[]
        `);
        await tx.restrictedScope.delete({ where: { tag } });
        return { tag, revokedPrincipals: principals.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function getOrCreateLineage(
  tx: Prisma.TransactionClient,
  input: {
    kind: MemoryLineageKind;
    subjectHash: string;
    hmacKeyVersion?: number;
    agentPrincipalId?: string;
  },
): Promise<{ id: string; subjectHash: string }> {
  return tx.memoryLineageState.upsert({
    where: {
      kind_subjectHash: { kind: input.kind, subjectHash: input.subjectHash },
    },
    create: {
      kind: input.kind,
      subjectHash: input.subjectHash,
      hmacKeyVersion: input.hmacKeyVersion,
      agentPrincipalId: input.agentPrincipalId,
    },
    update: {},
    select: { id: true, subjectHash: true },
  });
}

export async function quarantineLineage(
  tx: Prisma.TransactionClient,
  lineageStateId: string,
  reason: MemoryRevocationReason,
): Promise<number> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      kind: MemoryLineageKind;
      subjectHash: string;
      hmacKeyVersion: number | null;
      agentPrincipalId: string | null;
      generation: number;
      revokedAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT "id", "kind", "subjectHash", "hmacKeyVersion",
           "agentPrincipalId", "generation", "revokedAt"
    FROM "MemoryLineageState"
    WHERE "id" = ${lineageStateId}
    FOR UPDATE
  `);
  const lineage = rows[0];
  if (!lineage) throw new MemoryCaptureError("Memory lineage not found", 404);
  if (lineage.revokedAt) return lineage.generation;

  const now = new Date();
  const generation = lineage.generation + 1;
  await tx.memoryLineageState.update({
    where: { id: lineage.id },
    data: { generation, revokedAt: now },
  });

  const edgeFilter = { provenanceEdges: { some: { lineageStateId: lineage.id } } };
  await tx.memoryCapture.updateMany({
    where: edgeFilter,
    data: { status: "QUARANTINED", quarantinedAt: now },
  });
  await tx.memoryCandidate.updateMany({
    where: edgeFilter,
    data: { status: "QUARANTINED", quarantinedAt: now },
  });
  await tx.articleRecallEnrichment.updateMany({
    where: edgeFilter,
    data: { status: "QUARANTINED", quarantinedAt: now },
  });
  await tx.memoryRetrievalStat.updateMany({
    where: edgeFilter,
    data: { quarantinedAt: now },
  });

  const affectedArticles = await tx.article.findMany({
    where: {
      memoryProvenanceEdges: { some: { lineageStateId: lineage.id } },
    },
    select: { id: true, status: true },
  });
  if (affectedArticles.length > 0) {
    await tx.article.updateMany({
      where: { id: { in: affectedArticles.map((article) => article.id) } },
      data: {
        recallQuarantinedAt: now,
        recallQuarantineReason: reason,
        memoryRevocationGeneration: { increment: 1 },
      },
    });
    const reviewable = affectedArticles.filter(
      (article) => article.status === "reviewed" || article.status === "published",
    );
    for (const article of reviewable) {
      await tx.memoryPrivacyReview.upsert({
        where: {
          articleId_lineageStateId_generation: {
            articleId: article.id,
            lineageStateId: lineage.id,
            generation,
          },
        },
        create: {
          articleId: article.id,
          lineageStateId: lineage.id,
          generation,
          status: MemoryPrivacyReviewStatus.OPEN,
          reasonCode: reason,
        },
        update: {},
      });
    }
  }

  await tx.memoryTombstone.upsert({
    where: {
      lineageStateId_generation: { lineageStateId: lineage.id, generation },
    },
    create: {
      lineageStateId: lineage.id,
      kind: lineage.kind,
      subjectHash: lineage.subjectHash,
      hmacKeyVersion: lineage.hmacKeyVersion,
      generation,
      agentPrincipalId: lineage.agentPrincipalId,
      reasonCode: reason,
      expiresAt: new Date(now.getTime() + TOMBSTONE_TTL_MS),
    },
    update: {},
  });
  await tx.memoryDurableJob.upsert({
    where: { idempotencyKey: `memory-cleanup:${lineage.id}:${generation}` },
    create: {
      kind: "memory_privacy_cleanup",
      idempotencyKey: `memory-cleanup:${lineage.id}:${generation}`,
      lineageStateId: lineage.id,
      agentPrincipalId: lineage.agentPrincipalId,
      payload: { lineageStateId: lineage.id, generation, reason },
    },
    update: {},
  });

  return generation;
}
