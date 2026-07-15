import {
  MemoryCaptureStatus,
  MemoryLineageKind,
  Permissions,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CAPTURE_HMAC_ALGORITHM,
  digestWithActiveKey,
  digestWithAllKeys,
  type CaptureHmacKeyring,
} from "./crypto";
import type { ValidatedMemoryCaptureInput } from "./validation";

const CAPTURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SERIALIZABLE_RETRY_LIMIT = 3;

type LockedCapturePrincipal = {
  keyId: string;
  permissions: Permissions;
  allowedScopes: string[];
  keyRevokedAt: Date | null;
  principalId: string;
  privateScopeTag: string;
  principalStatus: "ACTIVE" | "REVOKED";
  principalRevokedAt: Date | null;
};

type LockedCaptureKey = Pick<
  LockedCapturePrincipal,
  "keyId" | "permissions" | "allowedScopes" | "keyRevokedAt"
> & { agentPrincipalId: string | null };

type LockedPrincipal = Pick<
  LockedCapturePrincipal,
  "principalId" | "privateScopeTag" | "principalStatus" | "principalRevokedAt"
>;

type LockedLineage = {
  id: string;
  generation: number;
  revokedAt: Date | null;
};

export type LockedArtifactProvenance = LockedLineage & {
  kind: MemoryLineageKind;
  sourceGroupId: string;
  generationSnapshot: number;
};

export type AuthenticatedCapturePrincipal = {
  keyId: string;
  agentPrincipalId: string;
};

export type PersistedCapture = {
  id: string;
  status: MemoryCaptureStatus;
  occurrenceCount: number;
  created: boolean;
};

export type PersistCaptureInput = {
  auth: AuthenticatedCapturePrincipal;
  capture: ValidatedMemoryCaptureInput;
  keyring: CaptureHmacKeyring;
  now?: Date;
};

export interface MemoryCaptureRepository {
  createOrIncrement(input: PersistCaptureInput): Promise<PersistedCapture>;
}

export class PrismaMemoryCaptureRepository implements MemoryCaptureRepository {
  async createOrIncrement(input: PersistCaptureInput): Promise<PersistedCapture> {
    return withSerializableRetry(() =>
      prisma.$transaction(
        (tx) => createOrIncrementInTransaction(tx, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }
}

async function createOrIncrementInTransaction(
  tx: Prisma.TransactionClient,
  input: PersistCaptureInput,
): Promise<PersistedCapture> {
  const now = input.now ?? new Date();
  const principal = await lockAndValidateCapturePrincipal(tx, input.auth);

  const sessionDigests = digestWithAllKeys(
    input.keyring,
    "session",
    principal.principalId,
    [input.capture.sourceSessionId],
  );
  const activeSessionDigest = digestWithActiveKey(
    input.keyring,
    "session",
    principal.principalId,
    [input.capture.sourceSessionId],
  );
  const runDigest = input.capture.sourceRunId
    ? digestWithActiveKey(input.keyring, "run", principal.principalId, [
        input.capture.sourceRunId,
      ])
    : undefined;
  const dedupeDigests = digestWithAllKeys(
    input.keyring,
    "capture-dedupe",
    principal.principalId,
    [
      input.capture.sourceSessionId,
      input.capture.sourceRunId ?? "",
      input.capture.userText,
      input.capture.assistantText,
    ],
  );
  const activeDedupe = digestWithActiveKey(
    input.keyring,
    "capture-dedupe",
    principal.principalId,
    [
      input.capture.sourceSessionId,
      input.capture.sourceRunId ?? "",
      input.capture.userText,
      input.capture.assistantText,
    ],
  );

  const existing = await tx.memoryCapture.findFirst({
    where: {
      agentPrincipalId: principal.principalId,
      dedupeKey: { in: dedupeDigests.map((entry) => entry.digest) },
    },
    select: {
      id: true,
      status: true,
      occurrenceCount: true,
      expiresAt: true,
      quarantinedAt: true,
    },
  });

  if (existing) {
    const provenance = await lockAndAssertArtifactProvenance(
      tx,
      "captureId",
      existing.id,
    );
    if (
      existing.quarantinedAt ||
      existing.status === MemoryCaptureStatus.QUARANTINED ||
      existing.status === MemoryCaptureStatus.EXPIRED ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw new MemoryCaptureError("Capture lineage is no longer eligible", 409);
    }

    const updated = await tx.memoryCapture.update({
      where: { id: existing.id },
      data: {
        occurrenceCount: { increment: 1 },
        lastSeenAt: now,
      },
      select: { id: true, status: true, occurrenceCount: true },
    });
    const captureLineage = provenance.find(
      ({ kind }) => kind === MemoryLineageKind.CAPTURE,
    );
    if (!captureLineage) {
      throw new MemoryCaptureError("Capture lineage is incomplete", 409);
    }
    await scheduleCaptureExpiry(
      tx,
      updated.id,
      principal.principalId,
      captureLineage.id,
      existing.expiresAt,
    );
    return { ...updated, created: false };
  }

  const lineageSpecs = [
    {
      kind: MemoryLineageKind.PRINCIPAL,
      subjectHash: `principal:${principal.principalId}`,
      hmacKeyVersion: null,
    },
    {
      kind: MemoryLineageKind.SCOPE,
      subjectHash: `scope:${principal.privateScopeTag}`,
      hmacKeyVersion: null,
    },
    {
      kind: MemoryLineageKind.SESSION,
      subjectHash: activeSessionDigest.digest,
      hmacKeyVersion: activeSessionDigest.keyVersion,
    },
    {
      kind: MemoryLineageKind.CAPTURE,
      subjectHash: activeDedupe.digest,
      hmacKeyVersion: activeDedupe.keyVersion,
    },
  ].sort(compareLineageSpecs);

  const lineageRecords: Array<{
    id: string;
    kind: MemoryLineageKind;
    subjectHash: string;
  }> = [];
  for (const spec of lineageSpecs) {
    const lineage = await tx.memoryLineageState.upsert({
      where: {
        kind_subjectHash: { kind: spec.kind, subjectHash: spec.subjectHash },
      },
      create: {
        ...spec,
        agentPrincipalId:
          spec.kind === MemoryLineageKind.SCOPE ? null : principal.principalId,
      },
      update: {},
      select: { id: true },
    });
    lineageRecords.push({ id: lineage.id, kind: spec.kind, subjectHash: spec.subjectHash });
  }

  const lineageIds = lineageRecords.map(({ id }) => id);
  const lockedLineages = await lockLineages(tx, lineageIds);
  if (lockedLineages.length !== lineageIds.length) {
    throw new MemoryCaptureError("Capture lineage could not be established", 409);
  }
  for (const lineage of lockedLineages) {
    if (lineage.revokedAt) {
      throw new MemoryCaptureError("Capture lineage has been revoked", 409);
    }
  }

  // A tombstone from any retained key version blocks recreation. Historical
  // keys remain in the bounded keyring until their tombstones and source TTLs
  // have expired.
  const blocked = await tx.memoryTombstone.findFirst({
    where: {
      kind: MemoryLineageKind.CAPTURE,
      subjectHash: { in: dedupeDigests.map((entry) => entry.digest) },
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (blocked) {
    throw new MemoryCaptureError("Capture was previously revoked", 409);
  }

  // Keep the multi-version session digests alive in this transaction so a
  // serializable retry observes concurrent session revocations consistently.
  await tx.memoryLineageState.findFirst({
    where: {
      kind: MemoryLineageKind.SESSION,
      subjectHash: { in: sessionDigests.map((entry) => entry.digest) },
      revokedAt: { not: null },
    },
    select: { id: true },
  }).then((revoked) => {
    if (revoked) throw new MemoryCaptureError("Session lineage has been revoked", 409);
  });

  const capture = await tx.memoryCapture.create({
    data: {
      dedupeKey: activeDedupe.digest,
      dedupeKeyVersion: activeDedupe.keyVersion,
      hmacAlgorithm: CAPTURE_HMAC_ALGORITHM,
      agentPrincipalId: principal.principalId,
      privateScopeTag: principal.privateScopeTag,
      sourceSessionHash: activeSessionDigest.digest,
      sourceSessionKeyVersion: activeSessionDigest.keyVersion,
      sourceRunHash: runDigest?.digest,
      sourceRunKeyVersion: runDigest?.keyVersion,
      userText: input.capture.userText,
      assistantText: input.capture.assistantText,
      restrictedTags: [principal.privateScopeTag],
      expiresAt: new Date(now.getTime() + CAPTURE_TTL_MS),
      firstSeenAt: now,
      lastSeenAt: now,
      provenanceEdges: {
        create: lockedLineages.map((lineage) => ({
          sourceGroupId: activeDedupe.digest,
          lineageStateId: lineage.id,
          generationSnapshot: lineage.generation,
        })),
      },
    },
    select: { id: true, status: true, occurrenceCount: true },
  });

  const captureLineage = lineageRecords.find(
    ({ kind }) => kind === MemoryLineageKind.CAPTURE,
  );
  if (!captureLineage) {
    throw new MemoryCaptureError("Capture lineage is incomplete", 409);
  }
  await scheduleCaptureExpiry(
    tx,
    capture.id,
    principal.principalId,
    captureLineage.id,
    new Date(now.getTime() + CAPTURE_TTL_MS),
  );

  return { ...capture, created: true };
}

async function scheduleCaptureExpiry(
  tx: Prisma.TransactionClient,
  captureId: string,
  agentPrincipalId: string,
  lineageStateId: string,
  expiresAt: Date,
): Promise<void> {
  await tx.memoryDurableJob.upsert({
    where: { idempotencyKey: `memory-capture-expiry:${captureId}` },
    create: {
      kind: "memory_capture_expiry",
      idempotencyKey: `memory-capture-expiry:${captureId}`,
      payload: { captureId },
      lineageStateId,
      agentPrincipalId,
      nextAttemptAt: expiresAt,
    },
    update: {
      status: "PENDING",
      nextAttemptAt: expiresAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: null,
      lastErrorCode: null,
    },
  });
}

async function lockAndValidateCapturePrincipal(
  tx: Prisma.TransactionClient,
  auth: AuthenticatedCapturePrincipal,
): Promise<LockedCapturePrincipal> {
  const keyRows = await tx.$queryRaw<LockedCaptureKey[]>(Prisma.sql`
    SELECT
      k."id" AS "keyId",
      k."permissions" AS "permissions",
      k."allowedScopes" AS "allowedScopes",
      k."revokedAt" AS "keyRevokedAt",
      k."agentPrincipalId" AS "agentPrincipalId"
    FROM "ApiKey" k
    WHERE k."id" = ${auth.keyId}
    FOR UPDATE OF k
  `);
  const key = keyRows[0];
  if (
    !key ||
    key.keyRevokedAt ||
    key.agentPrincipalId !== auth.agentPrincipalId
  ) {
    throw new MemoryCaptureError("Capture principal is unavailable", 403);
  }

  const principalRows = await tx.$queryRaw<LockedPrincipal[]>(Prisma.sql`
    SELECT
      p."id" AS "principalId",
      p."privateScopeTag" AS "privateScopeTag",
      p."status" AS "principalStatus",
      p."revokedAt" AS "principalRevokedAt"
    FROM "MemoryAgentPrincipal" p
    WHERE p."id" = ${auth.agentPrincipalId}
    FOR UPDATE OF p
  `);
  const principal = principalRows[0];
  if (
    !principal ||
    principal.principalRevokedAt ||
    principal.principalStatus !== "ACTIVE"
  ) {
    throw new MemoryCaptureError("Capture principal is unavailable", 403);
  }
  const row: LockedCapturePrincipal = { ...key, ...principal };
  if (row.permissions !== Permissions.WRITE && row.permissions !== Permissions.ADMIN) {
    throw new MemoryCaptureError("WRITE permission is required", 403);
  }
  if (!row.privateScopeTag || row.privateScopeTag === "*") {
    throw new MemoryCaptureError("A private capture scope is required", 403);
  }
  // Wildcard access is deliberately insufficient for automatic capture. The
  // narrow private scope must be present explicitly.
  if (!row.allowedScopes.includes(row.privateScopeTag)) {
    throw new MemoryCaptureError("API key is not bound to the private capture scope", 403);
  }
  return row;
}

async function lockLineages(
  tx: Prisma.TransactionClient,
  lineageIds: string[],
): Promise<LockedLineage[]> {
  if (lineageIds.length === 0) return [];
  return tx.$queryRaw<LockedLineage[]>(Prisma.sql`
    SELECT "id", "generation", "revokedAt"
    FROM "MemoryLineageState"
    WHERE "id" IN (${Prisma.join(lineageIds)})
    ORDER BY "kind"::text, "subjectHash", "id"
    FOR UPDATE
  `);
}

export async function lockAndAssertArtifactProvenance(
  tx: Prisma.TransactionClient,
  target:
    | "captureId"
    | "candidateId"
    | "enrichmentArticleId"
    | "retrievalStatId"
    | "articleId",
  targetId: string,
): Promise<LockedArtifactProvenance[]> {
  const column = Prisma.raw(`e."${target}"`);
  const rows = await tx.$queryRaw<LockedArtifactProvenance[]>(Prisma.sql`
    SELECT l."id", l."kind", l."generation", l."revokedAt",
           e."sourceGroupId", e."generationSnapshot"
    FROM "MemoryProvenanceEdge" e
    JOIN "MemoryLineageState" l ON l."id" = e."lineageStateId"
    WHERE ${column} = ${targetId}
    ORDER BY l."kind"::text, l."subjectHash", l."id"
    FOR UPDATE OF l
  `);
  if (rows.length === 0) {
    throw new MemoryCaptureError("Artifact has no active provenance", 409);
  }
  if (!hasActiveProvenanceGroup(rows)) {
    throw new MemoryCaptureError("Artifact provenance has been revoked", 409);
  }
  return rows;
}

export function hasActiveProvenanceGroup(
  rows: LockedArtifactProvenance[],
): boolean {
  const groups = new Map<string, LockedArtifactProvenance[]>();
  for (const row of rows) {
    const group = groups.get(row.sourceGroupId) ?? [];
    group.push(row);
    groups.set(row.sourceGroupId, group);
  }
  return [...groups.values()].some((group) =>
    group.every(
      (row) =>
        row.revokedAt === null && row.generation === row.generationSnapshot,
    ),
  );
}

function compareLineageSpecs(
  left: { kind: MemoryLineageKind; subjectHash: string },
  right: { kind: MemoryLineageKind; subjectHash: string },
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.subjectHash.localeCompare(right.subjectHash)
  );
}

export async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" ||
          (error.code === "P2010" &&
            [error.meta?.code, error.meta?.driverAdapterError, error.message].some(
              (detail) =>
                typeof detail === "string" &&
                /(?:40001|40P01)/.test(detail),
            )));
      if (!retryable || attempt === SERIALIZABLE_RETRY_LIMIT) throw error;
    }
  }
  throw new Error("Serializable capture retry loop exhausted");
}

export class MemoryCaptureError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MemoryCaptureError";
  }
}
