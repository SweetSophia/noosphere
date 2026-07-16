import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import {
  MemoryRetrievalEvent,
  Permissions,
  Prisma,
} from "@prisma/client";
import { Pool, type PoolClient } from "pg";
import { prisma } from "@/lib/prisma";
import { GET as getCaptureDetail } from "@/app/api/memory/captures/[id]/route";
import { GET as listCaptures } from "@/app/api/memory/captures/route";
import { GET as listCandidates } from "@/app/api/memory/candidates/route";
import { GET as listJobs } from "@/app/api/memory/jobs/route";
import {
  GET as listPrincipals,
  POST as createPrincipal,
} from "@/app/api/memory/principals/route";
import {
  DELETE as deletePrincipal,
  GET as getPrincipalDetail,
} from "@/app/api/memory/principals/[id]/route";
import { GET as listPrivacyReviews } from "@/app/api/memory/privacy-reviews/route";
import { POST as revokeSessionRoute } from "@/app/api/memory/revocations/route";
import { GET as listTombstones } from "@/app/api/memory/tombstones/route";
import {
  createApiKeyRecord,
  rotateApiKeyCredential,
  updateApiKeyRecord,
} from "@/lib/api/key-mutations";
import { readAutomaticMemoryCaptureConfig } from "@/lib/memory/capture/config";
import type { CaptureHmacKeyring } from "@/lib/memory/capture/crypto";
import {
  createMemoryAgentPrincipal,
  deleteMemoryRestrictedScope,
  quarantineMemoryCapture,
  revokeMemoryAgentPrincipal,
  revokeMemorySession,
} from "@/lib/memory/capture/lifecycle";
import { runMemoryMaintenanceBatch } from "@/lib/memory/capture/maintenance";
import { PrismaMemoryCaptureRepository } from "@/lib/memory/capture/repository";
import { NoosphereProvider } from "@/lib/memory/noosphere";

const runId = crypto.randomUUID();
const prefix = `phase-a-${runId}`;
const scopeTag = `${prefix}-private`;
const repository = new PrismaMemoryCaptureRepository();
const integrationLockPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
let integrationLockClient: PoolClient | undefined;
const v1: CaptureHmacKeyring = {
  activeVersion: 1,
  keys: [{ version: 1, key: Buffer.alloc(32, 0x11) }],
};
const rotated: CaptureHmacKeyring = {
  activeVersion: 2,
  keys: [
    { version: 2, key: Buffer.alloc(32, 0x22) },
    { version: 1, key: Buffer.alloc(32, 0x11) },
  ],
};

before(async () => {
  integrationLockClient = await integrationLockPool.connect();
  await integrationLockClient.query("SELECT pg_advisory_lock($1::int)", [
    1_621_507_015,
  ]);
});

after(async () => {
  const principals = await prisma.memoryAgentPrincipal.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const principalIds = principals.map(({ id }) => id);
  const topics = await prisma.topic.findMany({
    where: { slug: { startsWith: prefix } },
    select: { id: true },
  });
  const topicIds = topics.map(({ id }) => id);

  await prisma.apiKey.deleteMany({ where: { name: { startsWith: prefix } } });
  if (topicIds.length > 0) {
    await prisma.article.deleteMany({ where: { topicId: { in: topicIds } } });
  }
  if (principalIds.length > 0) {
    await prisma.memoryRetrievalStat.deleteMany({
      where: { agentPrincipalId: { in: principalIds } },
    });
    await prisma.memoryCandidate.deleteMany({
      where: { agentPrincipalId: { in: principalIds } },
    });
    await prisma.memoryCapture.deleteMany({
      where: { agentPrincipalId: { in: principalIds } },
    });
    await prisma.memoryDurableJob.deleteMany({
      where: { agentPrincipalId: { in: principalIds } },
    });
    await prisma.memoryTombstone.deleteMany({
      where: { agentPrincipalId: { in: principalIds } },
    });
    await prisma.memoryLineageState.deleteMany({
      where: { agentPrincipalId: { in: principalIds } },
    });
    await prisma.memoryAgentPrincipal.deleteMany({
      where: { id: { in: principalIds } },
    });
  }
  await prisma.memoryLineageState.deleteMany({
    where: { kind: "SCOPE", subjectHash: { startsWith: `scope:${prefix}` } },
  });
  if (topicIds.length > 0) {
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  }
  await prisma.restrictedScope.deleteMany({
    where: { tag: { startsWith: prefix } },
  });
  await prisma.$disconnect();
  if (integrationLockClient) {
    await integrationLockClient.query("SELECT pg_advisory_unlock($1::int)", [
      1_621_507_015,
    ]);
    integrationLockClient.release();
  }
  await integrationLockPool.end();
});

test("Article revocation generations reject negative creates and updates", async () => {
  const topic = await prisma.topic.create({
    data: {
      name: `${prefix} generation constraint topic`,
      slug: `${prefix}-generation-constraint-topic`,
    },
  });

  await assert.rejects(
    () =>
      prisma.article.create({
        data: {
          title: `${prefix} invalid negative generation`,
          slug: `${prefix}-invalid-negative-generation`,
          content: "This row must be rejected by the database constraint.",
          topicId: topic.id,
          memoryRevocationGeneration: -1,
        },
      }),
    /Article_memoryRevocationGeneration_nonnegative|check constraint|23514/i,
  );

  const article = await prisma.article.create({
    data: {
      title: `${prefix} valid generation`,
      slug: `${prefix}-valid-generation`,
      content: "This row begins with a valid generation.",
      topicId: topic.id,
    },
  });
  await assert.rejects(
    () =>
      prisma.article.update({
        where: { id: article.id },
        data: { memoryRevocationGeneration: -1 },
      }),
    /Article_memoryRevocationGeneration_nonnegative|check constraint|23514/i,
  );
  await prisma.article.delete({ where: { id: article.id } });
  await prisma.topic.delete({ where: { id: topic.id } });
});

test("Article quarantine requires a nonblank reason on creates and updates", async () => {
  const topic = await prisma.topic.create({
    data: {
      name: `${prefix} quarantine constraint topic`,
      slug: `${prefix}-quarantine-constraint-topic`,
    },
  });
  const quarantinedAt = new Date();

  await assert.rejects(
    () =>
      prisma.article.create({
        data: {
          title: `${prefix} invalid quarantine create`,
          slug: `${prefix}-invalid-quarantine-create`,
          content: "A quarantined row without a reason must be rejected.",
          topicId: topic.id,
          recallQuarantinedAt: quarantinedAt,
          recallQuarantineReason: "   ",
        },
      }),
    /Article_recallQuarantine_reason|check constraint|23514/i,
  );

  const article = await prisma.article.create({
    data: {
      title: `${prefix} valid quarantine candidate`,
      slug: `${prefix}-valid-quarantine-candidate`,
      content: "This row starts outside quarantine.",
      topicId: topic.id,
    },
  });
  await assert.rejects(
    () =>
      prisma.article.update({
        where: { id: article.id },
        data: {
          recallQuarantinedAt: quarantinedAt,
          recallQuarantineReason: null,
        },
      }),
    /Article_recallQuarantine_reason|check constraint|23514/i,
  );
  await prisma.article.delete({ where: { id: article.id } });
  await prisma.topic.delete({ where: { id: topic.id } });
});

test("Phase A preserves private lineage, immutable identity, rotation, and disabled-mode cleanup", async () => {
  await prisma.restrictedScope.create({
    data: { tag: scopeTag, description: `${prefix} private memory` },
  });
  const topic = await prisma.topic.create({
    data: {
      name: `${prefix} topic`,
      slug: `${prefix}-topic`,
      description: "Disposable Phase A integration topic",
    },
  });
  const principal = await createMemoryAgentPrincipal({
    name: `${prefix} principal one`,
    privateScopeTag: scopeTag,
  });
  const secondPrincipal = await createMemoryAgentPrincipal({
    name: `${prefix} principal two`,
    privateScopeTag: scopeTag,
  });
  const otherScopeTag = `${prefix}-other-private`;
  await prisma.restrictedScope.create({ data: { tag: otherScopeTag } });
  const otherScopePrincipal = await createMemoryAgentPrincipal({
    name: `${prefix} principal other scope`,
    privateScopeTag: otherScopeTag,
  });
  const firstCredential = await createApiKeyRecord({
    name: `${prefix} key one`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag],
    agentPrincipalId: principal.id,
  });
  const secondCredential = await createApiKeyRecord({
    name: `${prefix} key two`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag],
    agentPrincipalId: secondPrincipal.id,
  });
  const unboundCredential = await createApiKeyRecord({
    name: `${prefix} key unbound`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag],
  });
  const unscopedAdminCredential = await createApiKeyRecord({
    name: `${prefix} admin unscoped`,
    permissions: Permissions.ADMIN,
    allowedScopes: [],
  });
  const scopedAdminCredential = await createApiKeyRecord({
    name: `${prefix} admin scoped`,
    permissions: Permissions.ADMIN,
    allowedScopes: [scopeTag],
  });
  const wildcardAdminCredential = await createApiKeyRecord({
    name: `${prefix} admin wildcard`,
    permissions: Permissions.ADMIN,
    allowedScopes: ["*"],
  });
  const otherScopeCredential = await createApiKeyRecord({
    name: `${prefix} other-scope key`,
    permissions: Permissions.WRITE,
    allowedScopes: [otherScopeTag],
    agentPrincipalId: otherScopePrincipal.id,
  });
  const crossScopeBoundCredential = await createApiKeyRecord({
    name: `${prefix} cross-scope bound key`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag, otherScopeTag],
    agentPrincipalId: principal.id,
  });
  assert.equal("keyHash" in firstCredential.key, false);
  assert.equal("keyHash" in scopedAdminCredential.key, false);
  const updatedCredential = await updateApiKeyRecord(firstCredential.key.id, {
    name: firstCredential.key.name,
  });
  assert.equal("keyHash" in updatedCredential, false);

  await assert.rejects(
    () =>
      prisma.apiKey.update({
        where: { id: unboundCredential.key.id },
        data: { agentPrincipalId: principal.id },
      }),
    hasImmutableBindingError,
  );
  await assert.rejects(
    () =>
      prisma.apiKey.update({
        where: { id: firstCredential.key.id },
        data: { agentPrincipalId: null },
      }),
    hasImmutableBindingError,
  );

  const turn = {
    sourceSessionId: "shared-raw-session-id",
    sourceRunId: "run-1",
    userText: "Please remember the durable private calibration decision for later work.",
    assistantText: "The calibration decision is recorded as a private Phase A observation.",
    strippedBlocks: [],
  };
  const created = await repository.createOrIncrement({
    auth: {
      keyId: firstCredential.key.id,
      agentPrincipalId: principal.id,
    },
    capture: turn,
    keyring: v1,
  });
  assert.equal(created.created, true);

  const stored = await prisma.memoryCapture.findUniqueOrThrow({
    where: { id: created.id },
    include: {
      provenanceEdges: { include: { lineageState: true } },
    },
  });
  assert.deepEqual(stored.restrictedTags, [scopeTag]);
  const detailParams = { params: Promise.resolve({ id: created.id }) };
  const creatorDetail = await getCaptureDetail(
    captureDetailRequest(created.id, firstCredential.raw),
    detailParams,
  );
  assert.equal(creatorDetail.status, 200);
  assert.equal((await creatorDetail.json()).capture.userText, turn.userText);
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(created.id, secondCredential.raw),
        detailParams,
      )
    ).status,
    403,
    "a different principal cannot read raw capture text",
  );
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(created.id, unscopedAdminCredential.raw),
        detailParams,
      )
    ).status,
    403,
    "API ADMIN permission does not bypass restricted scopes",
  );
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(created.id, scopedAdminCredential.raw),
        detailParams,
      )
    ).status,
    200,
    "a scope-authorized API administrator can inspect the capture",
  );
  await assert.rejects(
    () =>
      prisma.$executeRaw(Prisma.sql`
        UPDATE "MemoryCapture"
        SET "restrictedTags" = NULL
        WHERE id = ${created.id}
      `),
    /immutable|null value|Null constraint|23502|23514/i,
    "the database must reject a null capture scope array",
  );
  await assert.rejects(
    () =>
      prisma.memoryCapture.create({
        data: {
          dedupeKey: `${prefix}-mismatched-capture`,
          dedupeKeyVersion: 1,
          hmacAlgorithm: "HMAC-SHA-256",
          agentPrincipalId: otherScopePrincipal.id,
          privateScopeTag: scopeTag,
          sourceSessionHash: `${prefix}-mismatched-session`,
          sourceSessionKeyVersion: 1,
          userText: "This mismatched private capture must never be stored.",
          assistantText: "The database rejects its forged inherited scope.",
          restrictedTags: [scopeTag],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
    /private scope must match its principal|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.memoryCapture.create({
        data: {
          dedupeKey: `${prefix}-incomplete-canonical-capture`,
          dedupeKeyVersion: 1,
          hmacAlgorithm: "HMAC-SHA-256",
          agentPrincipalId: principal.id,
          privateScopeTag: scopeTag,
          sourceSessionHash: `${prefix}-incomplete-canonical-session`,
          sourceSessionKeyVersion: 1,
          userText: "This direct raw capture omits canonical provenance.",
          assistantText: "The deferred database invariant must reject it.",
          restrictedTags: [scopeTag],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
    /requires complete canonical active provenance|23514/i,
    "raw capture writes require exact canonical principal, scope, session, and capture lineage",
  );
  await assert.rejects(
    () =>
      prisma.memoryLineageState.create({
        data: {
          kind: "SCOPE",
          subjectHash: `scope:${prefix}-forged-owned-scope`,
          agentPrincipalId: principal.id,
        },
      }),
    /kind_principal_ownership|constraint|23514/i,
    "scope lineage cannot borrow a principal relation to bypass list authorization",
  );
  await assert.rejects(
    () =>
      prisma.memoryCapture.update({
        where: { id: created.id },
        data: { expiresAt: new Date(stored.createdAt.getTime() + 31 * 24 * 60 * 60 * 1000) },
      }),
    /constraint|23514/i,
    "the database must enforce the hard 30-day raw-capture retention bound",
  );
  assert.equal(stored.dedupeKeyVersion, 1);
  assert.equal(stored.sourceSessionKeyVersion, 1);
  assert.equal(
    await prisma.memoryDurableJob.count({
      where: { idempotencyKey: `memory-capture-expiry:${created.id}` },
    }),
    1,
  );

  const rotatedCredential = await rotateApiKeyCredential(firstCredential.key.id);
  assert.equal(rotatedCredential.key.agentPrincipalId, principal.id);
  assert.equal("keyHash" in rotatedCredential.key, false);
  const originalExpiry = stored.expiresAt;
  const deduplicatedAcrossHmacRotation = await repository.createOrIncrement({
    auth: {
      keyId: rotatedCredential.key.id,
      agentPrincipalId: principal.id,
    },
    capture: turn,
    keyring: rotated,
  });
  assert.equal(deduplicatedAcrossHmacRotation.id, created.id);
  assert.equal(deduplicatedAcrossHmacRotation.created, false);
  assert.equal(deduplicatedAcrossHmacRotation.occurrenceCount, 2);
  assert.equal(
    (await prisma.memoryCapture.findUniqueOrThrow({ where: { id: created.id } }))
      .expiresAt.getTime(),
    originalExpiry.getTime(),
    "duplicate delivery must not extend the fixed raw-capture TTL",
  );
  await assert.rejects(
    () =>
      repository.createOrIncrement({
        auth: {
          keyId: rotatedCredential.key.id,
          agentPrincipalId: principal.id,
        },
        capture: turn,
        keyring: rotated,
        now: new Date(originalExpiry.getTime() + 1),
      }),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 409,
      ),
    "an overdue capture cannot be resurrected by a duplicate delivery",
  );
  assert.equal(
    (await prisma.memoryCapture.findUniqueOrThrow({ where: { id: created.id } }))
      .quarantinedAt,
    null,
    "credential rotation must not revoke memory provenance",
  );

  const secondCapture = await repository.createOrIncrement({
    auth: {
      keyId: secondCredential.key.id,
      agentPrincipalId: secondPrincipal.id,
    },
    capture: turn,
    keyring: v1,
  });
  const secondStored = await prisma.memoryCapture.findUniqueOrThrow({
    where: { id: secondCapture.id },
  });
  assert.notEqual(secondStored.sourceSessionHash, stored.sourceSessionHash);
  assert.notEqual(secondStored.dedupeKey, stored.dedupeKey);

  const captureOnlyRevocation = await repository.createOrIncrement({
    auth: {
      keyId: rotatedCredential.key.id,
      agentPrincipalId: principal.id,
    },
    capture: {
      ...turn,
      sourceSessionId: "capture-only-revocation-session",
      sourceRunId: "capture-only-revocation-run",
    },
    keyring: rotated,
  });
  await quarantineMemoryCapture(captureOnlyRevocation.id);
  const captureOnlyParams = {
    params: Promise.resolve({ id: captureOnlyRevocation.id }),
  };
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(captureOnlyRevocation.id, rotatedCredential.raw),
        captureOnlyParams,
      )
    ).status,
    403,
    "a creator loses raw detail access as soon as the capture is quarantined",
  );
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(captureOnlyRevocation.id, scopedAdminCredential.raw),
        captureOnlyParams,
      )
    ).status,
    200,
    "a scope-authorized administrator retains explicit privacy-review access",
  );

  const sessionLineage = stored.provenanceEdges.find(
    ({ lineageState }) => lineageState.kind === "SESSION",
  )?.lineageState;
  const principalLineage = stored.provenanceEdges.find(
    ({ lineageState }) => lineageState.kind === "PRINCIPAL",
  )?.lineageState;
  const scopeLineage = stored.provenanceEdges.find(
    ({ lineageState }) => lineageState.kind === "SCOPE",
  )?.lineageState;
  assert.ok(sessionLineage);
  assert.ok(principalLineage);
  assert.ok(scopeLineage);
  const sourceGroupId = `capture:${created.id}`;
  const independentLineage = await prisma.memoryLineageState.create({
    data: {
      kind: "CONSENT",
      subjectHash: `${prefix}-independent-consent`,
      agentPrincipalId: principal.id,
    },
  });
  const secondPrincipalLineage = await prisma.memoryLineageState.findUniqueOrThrow({
    where: {
      kind_subjectHash: {
        kind: "PRINCIPAL",
        subjectHash: `principal:${secondPrincipal.id}`,
      },
    },
  });
  const revokedCandidateLineage = await prisma.memoryLineageState.create({
    data: {
      kind: "CONSENT",
      subjectHash: `${prefix}-revoked-candidate-consent`,
      agentPrincipalId: principal.id,
      generation: 1,
      revokedAt: new Date(),
    },
  });
  const forgedPrincipalLineage = await prisma.memoryLineageState.create({
    data: {
      kind: "PRINCIPAL",
      subjectHash: `${prefix}-forged-principal-lineage`,
      agentPrincipalId: principal.id,
    },
  });
  const candidate = await prisma.memoryCandidate.create({
    data: {
      dedupeKey: `${prefix}-candidate`,
      dedupeKeyVersion: 1,
      hmacAlgorithm: "HMAC-SHA-256",
      title: "Private calibration",
      content: "Private calibration candidate content",
      recallSummary: "Calibration decision and private Phase A observation.",
      searchTerms: ["calibration", "phase-a"],
      confidence: "high",
      restrictedTags: [scopeTag],
      agentPrincipalId: principal.id,
      privateScopeTag: scopeTag,
      sourceCaptureId: created.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      provenanceEdges: {
        create: stored.provenanceEdges.map(
          ({ lineageState, generationSnapshot }) => ({
            sourceGroupId,
            lineageStateId: lineageState.id,
            generationSnapshot,
          }),
        ),
      },
    },
  });
  await assert.rejects(
    () =>
      prisma.memoryProvenanceEdge.create({
        data: {
          sourceGroupId: stored.provenanceEdges[0].sourceGroupId,
          lineageStateId: independentLineage.id,
          generationSnapshot: independentLineage.generation,
          captureId: created.id,
        },
      }),
    /requires complete active principal-scoped provenance|23514/i,
    "source-capture edge changes must revalidate every derived candidate",
  );
  await assert.rejects(
    () =>
      prisma.memoryCandidate.update({
        where: { id: candidate.id },
        data: { sourceCaptureId: null },
      }),
    /source capture is immutable until quarantine|23514/i,
    "an active candidate cannot detach from its raw-source revocation lineage",
  );
  await assert.rejects(
    () => prisma.memoryCapture.delete({ where: { id: created.id } }),
    /cannot be deleted while derived candidates are active|23514/i,
    "direct capture deletion cannot orphan active derived candidates",
  );

  // Keep a second complete capture group so removing or moving the original
  // group leaves the capture itself valid. Any deferred failure must therefore
  // come from revalidating the multiple candidates that inherited that group.
  const captureSourceGroupId = stored.provenanceEdges[0].sourceGroupId;
  const secondaryCaptureGroupId = `${sourceGroupId}:secondary`;
  const secondaryConsentLineage = await prisma.memoryLineageState.create({
    data: {
      kind: "CONSENT",
      subjectHash: `${prefix}-secondary-capture-consent`,
      agentPrincipalId: principal.id,
    },
  });
  await prisma.memoryProvenanceEdge.createMany({
    data: [
      ...stored.provenanceEdges.map(({ lineageStateId, generationSnapshot }) => ({
        sourceGroupId: secondaryCaptureGroupId,
        lineageStateId,
        generationSnapshot,
        captureId: created.id,
      })),
      {
        sourceGroupId: secondaryCaptureGroupId,
        lineageStateId: secondaryConsentLineage.id,
        generationSnapshot: secondaryConsentLineage.generation,
        captureId: created.id,
      },
    ],
  });
  const secondaryCaptureEdges = await prisma.memoryProvenanceEdge.findMany({
    where: { captureId: created.id, sourceGroupId: secondaryCaptureGroupId },
  });
  const createBatchCandidate = async (
    suffix: string,
    inheritedSourceGroupId: string,
    sourceEdges: ReadonlyArray<{
      lineageStateId: string;
      generationSnapshot: number;
    }>,
  ) =>
    prisma.memoryCandidate.create({
      data: {
        dedupeKey: `${prefix}-batch-candidate-${suffix}`,
        dedupeKeyVersion: 1,
        hmacAlgorithm: "HMAC-SHA-256",
        title: `Batch candidate ${suffix}`,
        content: "Candidate used to exercise set-based deferred provenance validation.",
        recallSummary: "Set-based provenance validation regression candidate.",
        confidence: "high",
        restrictedTags: [scopeTag],
        agentPrincipalId: principal.id,
        privateScopeTag: scopeTag,
        sourceCaptureId: created.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        provenanceEdges: {
          create: sourceEdges.map(({ lineageStateId, generationSnapshot }) => ({
            sourceGroupId: inheritedSourceGroupId,
            lineageStateId,
            generationSnapshot,
          })),
        },
      },
    });
  const batchPrimaryOne = await createBatchCandidate(
    "primary-one",
    `${prefix}-batch-primary-one`,
    stored.provenanceEdges,
  );
  const batchPrimaryTwo = await createBatchCandidate(
    "primary-two",
    `${prefix}-batch-primary-two`,
    stored.provenanceEdges,
  );
  const batchSecondary = await createBatchCandidate(
    "secondary",
    `${prefix}-batch-secondary`,
    secondaryCaptureEdges,
  );

  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryProvenanceEdge.updateMany({
          where: { captureId: created.id, sourceGroupId: captureSourceGroupId },
          data: {
            captureId: null,
            candidateId: batchSecondary.id,
            sourceGroupId: `${prefix}-moved-capture-group`,
          },
        });
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      }),
    /requires complete active principal-scoped provenance|23514/i,
    "moving a capture group must revalidate every candidate that inherited it",
  );
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryProvenanceEdge.deleteMany({
          where: { captureId: created.id, sourceGroupId: captureSourceGroupId },
        });
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      }),
    /requires complete active principal-scoped provenance|23514/i,
    "deleting a capture group must use the old CAPTURE anchor to revalidate inheriting candidates",
  );
  assert.equal(
    await prisma.memoryProvenanceEdge.count({
      where: { captureId: created.id, sourceGroupId: captureSourceGroupId },
    }),
    stored.provenanceEdges.length,
    "failed deferred mutations roll back the complete source group",
  );
  await prisma.memoryCandidate.deleteMany({
    where: { id: { in: [batchPrimaryOne.id, batchPrimaryTwo.id, batchSecondary.id] } },
  });
  await prisma.memoryProvenanceEdge.deleteMany({
    where: { captureId: created.id, sourceGroupId: secondaryCaptureGroupId },
  });

  const otherScopeTurn = {
    sourceSessionId: "other-scope-session",
    sourceRunId: "other-scope-run",
    userText: "Remember a private fact that belongs only to the other scope.",
    assistantText: "The other-scope fact is retained only in its own boundary.",
    strippedBlocks: [],
  };
  const otherScopeCapture = await repository.createOrIncrement({
    auth: {
      keyId: otherScopeCredential.key.id,
      agentPrincipalId: otherScopePrincipal.id,
    },
    capture: otherScopeTurn,
    keyring: v1,
  });
  const otherScopeStored = await prisma.memoryCapture.findUniqueOrThrow({
    where: { id: otherScopeCapture.id },
    include: { provenanceEdges: true },
  });
  const otherScopeCandidate = await prisma.memoryCandidate.create({
    data: {
      dedupeKey: `${prefix}-other-scope-candidate`,
      dedupeKeyVersion: 1,
      hmacAlgorithm: "HMAC-SHA-256",
      title: "Other-scope private candidate",
      content: "This derived fact must never appear in the first scope's admin lists.",
      recallSummary: "Other-scope private candidate used for authorization regression coverage.",
      confidence: "high",
      restrictedTags: [otherScopeTag],
      agentPrincipalId: otherScopePrincipal.id,
      privateScopeTag: otherScopeTag,
      sourceCaptureId: otherScopeCapture.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      provenanceEdges: {
        create: otherScopeStored.provenanceEdges.map(
          ({ lineageStateId, generationSnapshot }) => ({
            sourceGroupId: `${prefix}-other-scope-candidate-source`,
            lineageStateId,
            generationSnapshot,
          }),
        ),
      },
    },
  });
  const otherScopeArticle = await prisma.article.create({
    data: {
      title: `${prefix} other-scope reviewed memory`,
      slug: `${prefix}-other-scope-reviewed-memory`,
      content: "Reviewed private material belonging only to the other scope.",
      status: "reviewed",
      sourceType: "automatic-memory",
      topicId: topic.id,
      restrictedTags: [otherScopeTag],
      memoryProvenanceEdges: {
        create: otherScopeStored.provenanceEdges.map(
          ({ lineageStateId, generationSnapshot }) => ({
            sourceGroupId: `${prefix}-other-scope-article-source`,
            lineageStateId,
            generationSnapshot,
          }),
        ),
      },
    },
  });
  await quarantineMemoryCapture(otherScopeCapture.id);
  const otherScopePrivacyReview = await prisma.memoryPrivacyReview.findFirstOrThrow({
    where: { articleId: otherScopeArticle.id },
  });
  const otherScopeCaptureLineage = otherScopeStored.provenanceEdges.find(
    ({ lineageStateId }) =>
      lineageStateId === otherScopePrivacyReview.lineageStateId,
  );
  assert.ok(otherScopeCaptureLineage);

  const captureForCandidateRevocation = await repository.createOrIncrement({
    auth: {
      keyId: rotatedCredential.key.id,
      agentPrincipalId: principal.id,
    },
    capture: {
      ...turn,
      sourceSessionId: "capture-derived-candidate-revocation-session",
      sourceRunId: "capture-derived-candidate-revocation-run",
      userText: "Remember this disposable capture-derived candidate.",
      assistantText: "This candidate will prove capture revocation propagation.",
    },
    keyring: rotated,
  });
  const captureForCandidateRevocationWithEdges =
    await prisma.memoryCapture.findUniqueOrThrow({
      where: { id: captureForCandidateRevocation.id },
      include: { provenanceEdges: true },
    });
  const candidateForCaptureRevocation = await prisma.memoryCandidate.create({
    data: {
      dedupeKey: `${prefix}-candidate-capture-revocation`,
      dedupeKeyVersion: 2,
      hmacAlgorithm: "HMAC-SHA-256",
      title: "Capture-derived revocation candidate",
      content: "A candidate inherits every lineage edge from its source capture.",
      recallSummary: "Capture revocation must quarantine this candidate.",
      confidence: "high",
      restrictedTags: [scopeTag],
      agentPrincipalId: principal.id,
      privateScopeTag: scopeTag,
      sourceCaptureId: captureForCandidateRevocation.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      provenanceEdges: {
        create: captureForCandidateRevocationWithEdges.provenanceEdges.map(
          ({ lineageStateId, generationSnapshot }) => ({
            sourceGroupId: `${prefix}-candidate-capture-revocation-source`,
            lineageStateId,
            generationSnapshot,
          }),
        ),
      },
    },
  });
  await quarantineMemoryCapture(captureForCandidateRevocation.id);
  assert.equal(
    (
      await prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: candidateForCaptureRevocation.id },
      })
    ).status,
    "QUARANTINED",
    "capture revocation traverses inherited CAPTURE lineage to its candidate",
  );

  const unscopedCandidates = await listCandidates(
    memoryAdminListRequest("/api/memory/candidates", unscopedAdminCredential.raw),
  );
  assert.equal((await unscopedCandidates.json()).total, 0);
  const scopedCandidates = await listCandidates(
    memoryAdminListRequest("/api/memory/candidates", scopedAdminCredential.raw),
  );
  assertPrivateNoStore(scopedCandidates);
  const scopedCandidateBody = await scopedCandidates.json();
  assert.ok(
    scopedCandidateBody.candidates.some(
      ({ id }: { id: string }) => id === candidate.id,
    ),
  );
  assert.equal(
    scopedCandidateBody.candidates.some(
      ({ id }: { id: string }) => id === otherScopeCandidate.id,
    ),
    false,
  );
  const wildcardCandidateBody = await (
    await listCandidates(
      memoryAdminListRequest("/api/memory/candidates", wildcardAdminCredential.raw),
    )
  ).json();
  assert.ok(
    wildcardCandidateBody.candidates.some(
      ({ id }: { id: string }) => id === otherScopeCandidate.id,
    ),
  );

  const unscopedCaptures = await listCaptures(
    memoryAdminListRequest("/api/memory/captures", unscopedAdminCredential.raw),
  );
  assert.equal((await unscopedCaptures.json()).total, 0);
  const scopedCaptures = await listCaptures(
    memoryAdminListRequest("/api/memory/captures", scopedAdminCredential.raw),
  );
  assertPrivateNoStore(scopedCaptures);
  const scopedCaptureBody = await scopedCaptures.json();
  assert.ok(
    scopedCaptureBody.captures.some(
      ({ id }: { id: string }) => id === created.id,
    ),
  );
  assert.equal(
    scopedCaptureBody.captures.some(
      ({ id }: { id: string }) => id === otherScopeCapture.id,
    ),
    false,
  );
  const wildcardCaptureBody = await (
    await listCaptures(
      memoryAdminListRequest("/api/memory/captures", wildcardAdminCredential.raw),
    )
  ).json();
  assert.ok(
    wildcardCaptureBody.captures.some(
      ({ id }: { id: string }) => id === otherScopeCapture.id,
    ),
  );

  const unscopedPrincipals = await listPrincipals(
    memoryAdminListRequest("/api/memory/principals", unscopedAdminCredential.raw),
  );
  assert.deepEqual((await unscopedPrincipals.json()).principals, []);
  const scopedPrincipals = await listPrincipals(
    memoryAdminListRequest("/api/memory/principals", scopedAdminCredential.raw),
  );
  assertPrivateNoStore(scopedPrincipals);
  const scopedPrincipalRows = (await scopedPrincipals.json()).principals as Array<{
    id: string;
  }>;
  assert.ok(scopedPrincipalRows.some(({ id }) => id === principal.id));
  assert.equal(scopedPrincipalRows.some(({ id }) => id === otherScopePrincipal.id), false);
  const wildcardPrincipalRows = (
    await (
      await listPrincipals(
        memoryAdminListRequest("/api/memory/principals", wildcardAdminCredential.raw),
      )
    ).json()
  ).principals as Array<{ id: string }>;
  assert.ok(wildcardPrincipalRows.some(({ id }) => id === otherScopePrincipal.id));
  const principalParams = { params: Promise.resolve({ id: principal.id }) };
  assert.equal(
    (
      await getPrincipalDetail(
        memoryAdminListRequest(
          `/api/memory/principals/${principal.id}`,
          unscopedAdminCredential.raw,
        ),
        principalParams,
      )
    ).status,
    403,
  );
  const scopedPrincipalDetail = await getPrincipalDetail(
    memoryAdminListRequest(
      `/api/memory/principals/${principal.id}`,
      scopedAdminCredential.raw,
    ),
    principalParams,
  );
  assert.equal(scopedPrincipalDetail.status, 200);
  assertPrivateNoStore(scopedPrincipalDetail);
  const scopedPrincipalDetailBody = await scopedPrincipalDetail.json();
  assert.deepEqual(
    scopedPrincipalDetailBody.principal.apiKeys.find(
      ({ id }: { id: string }) => id === crossScopeBoundCredential.key.id,
    ).allowedScopes,
    [scopeTag],
    "principal detail redacts scope names outside the inspecting admin's boundary",
  );
  const wildcardPrincipalDetail = await getPrincipalDetail(
    memoryAdminListRequest(
      `/api/memory/principals/${principal.id}`,
      wildcardAdminCredential.raw,
    ),
    principalParams,
  );
  assert.equal(wildcardPrincipalDetail.status, 200);
  assert.deepEqual(
    (
      await wildcardPrincipalDetail.json()
    ).principal.apiKeys.find(
      ({ id }: { id: string }) => id === crossScopeBoundCredential.key.id,
    ).allowedScopes.sort(),
    [otherScopeTag, scopeTag].sort(),
  );
  const otherPrincipalParams = {
    params: Promise.resolve({ id: otherScopePrincipal.id }),
  };
  assert.equal(
    (
      await createPrincipal(
        memoryAdminJsonRequest(
          "/api/memory/principals",
          scopedAdminCredential.raw,
          {
            name: `${prefix} forbidden other-scope principal`,
            privateScopeTag: otherScopeTag,
          },
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await deletePrincipal(
        memoryAdminJsonRequest(
          `/api/memory/principals/${otherScopePrincipal.id}`,
          scopedAdminCredential.raw,
          undefined,
          "DELETE",
        ),
        otherPrincipalParams,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await revokeSessionRoute(
        memoryAdminJsonRequest(
          "/api/memory/revocations",
          scopedAdminCredential.raw,
          {
            kind: "session",
            principalId: otherScopePrincipal.id,
            sourceSessionId: otherScopeTurn.sourceSessionId,
          },
        ),
      )
    ).status,
    403,
  );

  const unscopedJobs = await listJobs(
    memoryAdminListRequest("/api/memory/jobs", unscopedAdminCredential.raw),
  );
  assert.equal((await unscopedJobs.json()).total, 0);
  const scopedJobs = await listJobs(
    memoryAdminListRequest("/api/memory/jobs", scopedAdminCredential.raw),
  );
  assertPrivateNoStore(scopedJobs);
  const scopedJobBody = await scopedJobs.json();
  assert.ok(scopedJobBody.total > 0);
  assert.equal(
    scopedJobBody.jobs.some(
      ({ agentPrincipalId }: { agentPrincipalId: string | null }) =>
        agentPrincipalId === otherScopePrincipal.id,
    ),
    false,
  );
  const wildcardJobBody = await (
    await listJobs(
      memoryAdminListRequest("/api/memory/jobs", wildcardAdminCredential.raw),
    )
  ).json();
  assert.ok(
    wildcardJobBody.jobs.some(
      ({ agentPrincipalId }: { agentPrincipalId: string | null }) =>
        agentPrincipalId === otherScopePrincipal.id,
    ),
  );

  const unscopedTombstones = await listTombstones(
    memoryAdminListRequest("/api/memory/tombstones", unscopedAdminCredential.raw),
  );
  assert.equal((await unscopedTombstones.json()).total, 0);
  const scopedTombstones = await listTombstones(
    memoryAdminListRequest("/api/memory/tombstones", scopedAdminCredential.raw),
  );
  assertPrivateNoStore(scopedTombstones);
  const scopedTombstoneBody = await scopedTombstones.json();
  assert.ok(scopedTombstoneBody.total > 0);
  assert.equal(
    scopedTombstoneBody.tombstones.some(
      ({ agentPrincipalId }: { agentPrincipalId: string | null }) =>
        agentPrincipalId === otherScopePrincipal.id,
    ),
    false,
  );
  const wildcardTombstoneBody = await (
    await listTombstones(
      memoryAdminListRequest("/api/memory/tombstones", wildcardAdminCredential.raw),
    )
  ).json();
  assert.ok(
    wildcardTombstoneBody.tombstones.some(
      ({ agentPrincipalId }: { agentPrincipalId: string | null }) =>
        agentPrincipalId === otherScopePrincipal.id,
    ),
  );
  await assert.rejects(
    () =>
      prisma.memoryCandidate.create({
        data: {
          dedupeKey: `${prefix}-cross-principal-candidate`,
          dedupeKeyVersion: 1,
          hmacAlgorithm: "HMAC-SHA-256",
          title: "Forged cross-principal candidate",
          content: "This candidate must not borrow another principal's capture.",
          recallSummary: "Cross-principal evidence is rejected.",
          confidence: "high",
          restrictedTags: [scopeTag],
          agentPrincipalId: secondPrincipal.id,
          privateScopeTag: scopeTag,
          sourceCaptureId: created.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
    /source capture must share principal and private scope|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.memoryCandidate.create({
        data: {
          dedupeKey: `${prefix}-mismatched-scope-candidate`,
          dedupeKeyVersion: 1,
          hmacAlgorithm: "HMAC-SHA-256",
          title: "Forged scope candidate",
          content: "This candidate must not override its principal's scope.",
          recallSummary: "Forged inherited scope is rejected.",
          confidence: "high",
          restrictedTags: [scopeTag],
          agentPrincipalId: otherScopePrincipal.id,
          privateScopeTag: scopeTag,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          provenanceEdges: {
            create: {
              sourceGroupId: `${prefix}-forged-source`,
              lineageStateId: independentLineage.id,
              generationSnapshot: independentLineage.generation,
            },
          },
        },
      }),
    /private scope must match its principal|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.memoryCandidate.create({
        data: {
          dedupeKey: `${prefix}-sourceless-candidate`,
          dedupeKeyVersion: 1,
          hmacAlgorithm: "HMAC-SHA-256",
          title: "Sourceless candidate",
          content: "A private candidate requires durable provenance.",
          recallSummary: "Candidates cannot exist without a source.",
          confidence: "high",
          restrictedTags: [scopeTag],
          agentPrincipalId: principal.id,
          privateScopeTag: scopeTag,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
    /requires complete active principal-scoped provenance|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryCandidate.create({
          data: {
            dedupeKey: `${prefix}-incomplete-capture-lineage-candidate`,
            dedupeKeyVersion: 1,
            hmacAlgorithm: "HMAC-SHA-256",
            title: "Incomplete capture lineage candidate",
            content: "A source capture requires its complete revocation lineage.",
            recallSummary: "Incomplete capture-derived provenance is rejected.",
            confidence: "high",
            restrictedTags: [scopeTag],
            agentPrincipalId: principal.id,
            privateScopeTag: scopeTag,
            sourceCaptureId: created.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            provenanceEdges: {
              create: [sessionLineage!, principalLineage!, scopeLineage!].map(
                (lineage) => ({
                  sourceGroupId: `${prefix}-incomplete-capture-source`,
                  lineageStateId: lineage.id,
                  generationSnapshot: lineage.generation,
                }),
              ),
            },
          },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryCandidate_source_required", "MemoryProvenanceEdge_candidate_source_required" IMMEDIATE',
        );
      }),
    /requires complete active principal-scoped provenance|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.memoryCandidate.create({
        data: {
          dedupeKey: `${prefix}-source-only-candidate`,
          dedupeKeyVersion: 1,
          hmacAlgorithm: "HMAC-SHA-256",
          title: "Source-only candidate",
          content: "A capture foreign key is not revocation authority.",
          recallSummary: "Source-only candidates are rejected.",
          confidence: "high",
          restrictedTags: [scopeTag],
          agentPrincipalId: principal.id,
          privateScopeTag: scopeTag,
          sourceCaptureId: created.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
    /requires complete active principal-scoped provenance|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryCandidate.create({
          data: {
            dedupeKey: `${prefix}-unrelated-provenance-candidate`,
            dedupeKeyVersion: 1,
            hmacAlgorithm: "HMAC-SHA-256",
            title: "Unrelated provenance candidate",
            content: "Another principal must not authorize this candidate.",
            recallSummary: "Cross-principal provenance is rejected.",
            confidence: "high",
            restrictedTags: [scopeTag],
            agentPrincipalId: principal.id,
            privateScopeTag: scopeTag,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            provenanceEdges: {
              create: [secondPrincipalLineage, scopeLineage!].map((lineage) => ({
                sourceGroupId: `${prefix}-unrelated-source`,
                lineageStateId: lineage.id,
                generationSnapshot: lineage.generation,
              })),
            },
          },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryCandidate_source_required", "MemoryProvenanceEdge_candidate_source_required" IMMEDIATE',
        );
      }),
    /requires complete active principal-scoped provenance|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryCandidate.create({
          data: {
            dedupeKey: `${prefix}-forged-principal-provenance-candidate`,
            dedupeKeyVersion: 1,
            hmacAlgorithm: "HMAC-SHA-256",
            title: "Forged principal provenance candidate",
            content: "A synthetic same-principal lineage must not authorize memory.",
            recallSummary: "Canonical principal provenance is required.",
            confidence: "high",
            restrictedTags: [scopeTag],
            agentPrincipalId: principal.id,
            privateScopeTag: scopeTag,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            provenanceEdges: {
              create: [forgedPrincipalLineage, scopeLineage!].map((lineage) => ({
                sourceGroupId: `${prefix}-forged-principal-source`,
                lineageStateId: lineage.id,
                generationSnapshot: lineage.generation,
              })),
            },
          },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryCandidate_source_required", "MemoryProvenanceEdge_candidate_source_required" IMMEDIATE',
        );
      }),
    /requires complete active principal-scoped provenance|23514/i,
  );
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryCandidate.create({
          data: {
            dedupeKey: `${prefix}-revoked-provenance-candidate`,
            dedupeKeyVersion: 1,
            hmacAlgorithm: "HMAC-SHA-256",
            title: "Revoked provenance candidate",
            content: "Revoked evidence must not authorize a late worker write.",
            recallSummary: "Revoked provenance is rejected.",
            confidence: "high",
            restrictedTags: [scopeTag],
            agentPrincipalId: principal.id,
            privateScopeTag: scopeTag,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            provenanceEdges: {
              create: [revokedCandidateLineage, principalLineage!, scopeLineage!].map(
                (lineage) => ({
                  sourceGroupId: `${prefix}-revoked-candidate-source`,
                  lineageStateId: lineage.id,
                  generationSnapshot: lineage.generation,
                }),
              ),
            },
          },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryCandidate_source_required", "MemoryProvenanceEdge_candidate_source_required" IMMEDIATE',
        );
      }),
    /requires complete active principal-scoped provenance|23514/i,
  );
  const survivingCandidate = await prisma.memoryCandidate.create({
    data: {
      dedupeKey: `${prefix}-candidate-independent`,
      dedupeKeyVersion: 1,
      hmacAlgorithm: "HMAC-SHA-256",
      title: "Multi-source private calibration",
      content: "A candidate with a separate authorized source group.",
      recallSummary: "Multi-source calibration evidence.",
      searchTerms: ["calibration", "multi-source"],
      confidence: "high",
      restrictedTags: [scopeTag],
      agentPrincipalId: principal.id,
      privateScopeTag: scopeTag,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      provenanceEdges: {
        create: [
          ...[sessionLineage!, principalLineage!, scopeLineage!].map((lineage) => ({
            sourceGroupId: `${prefix}-revoked-source`,
            lineageStateId: lineage.id,
            generationSnapshot: lineage.generation,
          })),
          ...[independentLineage, principalLineage!, scopeLineage!].map((lineage) => ({
            sourceGroupId: `${prefix}-independent-source`,
            lineageStateId: lineage.id,
            generationSnapshot: lineage.generation,
          })),
        ],
      },
    },
  });
  await assert.rejects(
    () =>
      prisma.$executeRaw(Prisma.sql`
        UPDATE "MemoryCandidate"
        SET "restrictedTags" = NULL
        WHERE id = ${candidate.id}
      `),
    /immutable|null value|Null constraint|23502|23514/i,
    "the database must reject a null candidate scope array",
  );
  const article = await prisma.article.create({
    data: {
      title: `${prefix} reviewed memory`,
      slug: `${prefix}-reviewed-memory`,
      content: "Reviewed memory derived from the private calibration session.",
      status: "reviewed",
      sourceType: "automatic-memory",
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: [sessionLineage!, principalLineage!].map((lineage) => ({
          sourceGroupId,
          lineageStateId: lineage.id,
          generationSnapshot: lineage.generation,
        })),
      },
    },
  });
  const survivingDraft = await prisma.article.create({
    data: {
      title: `${prefix} multi-source draft`,
      slug: `${prefix}-multi-source-draft`,
      content: "A generated draft with one independently authorized source group.",
      status: "draft",
      sourceType: "automatic-memory",
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: [
          ...[sessionLineage!, principalLineage!, scopeLineage!].map((lineage) => ({
            sourceGroupId: `${prefix}-draft-revoked-source`,
            lineageStateId: lineage.id,
            generationSnapshot: lineage.generation,
          })),
          ...[independentLineage, principalLineage!, scopeLineage!].map((lineage) => ({
            sourceGroupId: `${prefix}-draft-independent-source`,
            lineageStateId: lineage.id,
            generationSnapshot: lineage.generation,
          })),
        ],
      },
    },
  });
  const generatedDraft = await prisma.article.create({
    data: {
      title: `${prefix} generated single-source draft`,
      slug: `${prefix}-generated-single-source-draft`,
      content: "An unreviewed generated draft with no independent authorized source.",
      status: "draft",
      sourceType: "automatic-memory",
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: [sessionLineage!, principalLineage!, scopeLineage!].map((lineage) => ({
          sourceGroupId,
          lineageStateId: lineage.id,
          generationSnapshot: lineage.generation,
        })),
      },
    },
  });
  const humanAuthor = await prisma.user.create({
    data: {
      email: `${prefix}@example.invalid`,
      name: "Human reviewer",
      passwordHash: "test-only-not-a-real-credential",
    },
  });
  const humanDraft = await prisma.article.create({
    data: {
      title: `${prefix} human single-source draft`,
      slug: `${prefix}-human-single-source-draft`,
      content: "A human-authored draft must never be hard-deleted by automatic cleanup.",
      status: "draft",
      sourceType: "automatic-memory",
      authorId: humanAuthor.id,
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: [sessionLineage!, principalLineage!, scopeLineage!].map((lineage) => ({
          sourceGroupId,
          lineageStateId: lineage.id,
          generationSnapshot: lineage.generation,
        })),
      },
    },
  });
  const manualDraft = await prisma.article.create({
    data: {
      title: `${prefix} manual single-source draft`,
      slug: `${prefix}-manual-single-source-draft`,
      content: "A manual draft without a bound author still requires human privacy review.",
      status: "draft",
      sourceType: "manual",
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: [sessionLineage!, principalLineage!, scopeLineage!].map((lineage) => ({
          sourceGroupId,
          lineageStateId: lineage.id,
          generationSnapshot: lineage.generation,
        })),
      },
    },
  });
  await prisma.articleRecallEnrichment.create({
    data: {
      articleId: article.id,
      sourceHash: `${prefix}-source-hash`,
      recallSummary: "Private calibration recall enrichment.",
      searchTerms: ["calibration"],
      generatorKind: "deterministic",
      generatorId: "phase-a-test",
      promptVersion: "v1",
      provenanceEdges: {
        create: {
          sourceGroupId,
          lineageStateId: sessionLineage!.id,
          generationSnapshot: sessionLineage!.generation,
        },
      },
    },
  });
  const stat = await prisma.memoryRetrievalStat.create({
    data: {
      eventType: MemoryRetrievalEvent.EXPLICIT_GET,
      provider: "noosphere",
      retrievalMode: "explicit",
      agentPrincipalId: principal.id,
      captureId: created.id,
      candidateId: candidate.id,
      articleId: article.id,
      provenanceEdges: {
        create: {
          sourceGroupId,
          lineageStateId: sessionLineage!.id,
          generationSnapshot: sessionLineage!.generation,
        },
      },
    },
  });

  await revokeMemorySession({
    principalId: principal.id,
    sourceSessionId: turn.sourceSessionId,
    keyring: rotated,
  });
  assert.ok(
    (await prisma.memoryCapture.findUniqueOrThrow({ where: { id: created.id } }))
      .quarantinedAt,
  );
  assert.equal(
    (await prisma.memoryCandidate.findUniqueOrThrow({ where: { id: candidate.id } }))
      .status,
    "QUARANTINED",
  );
  assert.ok(
    (await prisma.memoryRetrievalStat.findUniqueOrThrow({ where: { id: stat.id } }))
      .quarantinedAt,
  );
  assert.ok(
    (await prisma.article.findUniqueOrThrow({ where: { id: article.id } }))
      .recallQuarantinedAt,
  );
  const provider = new NoosphereProvider({ allowedScopes: [scopeTag] });
  assert.equal(
    await provider.getById(article.id),
    null,
    "direct recall revalidates article quarantine in PostgreSQL",
  );
  assert.equal(
    await prisma.memoryPrivacyReview.count({ where: { articleId: article.id } }),
    1,
  );
  const unscopedPrivacyReviews = await listPrivacyReviews(
    memoryAdminListRequest(
      "/api/memory/privacy-reviews",
      unscopedAdminCredential.raw,
    ),
  );
  assert.equal((await unscopedPrivacyReviews.json()).total, 0);
  const scopedPrivacyReviews = await listPrivacyReviews(
    memoryAdminListRequest(
      "/api/memory/privacy-reviews",
      scopedAdminCredential.raw,
    ),
  );
  assertPrivateNoStore(scopedPrivacyReviews);
  const scopedPrivacyReviewBody = await scopedPrivacyReviews.json();
  assert.ok(scopedPrivacyReviewBody.total > 0);
  assert.equal(
    scopedPrivacyReviewBody.reviews.some(
      ({ id }: { id: string }) => id === otherScopePrivacyReview.id,
    ),
    false,
  );
  const wildcardPrivacyReviewBody = await (
    await listPrivacyReviews(
      memoryAdminListRequest(
        "/api/memory/privacy-reviews",
        wildcardAdminCredential.raw,
      ),
    )
  ).json();
  assert.ok(
    wildcardPrivacyReviewBody.reviews.some(
      ({ id }: { id: string }) => id === otherScopePrivacyReview.id,
    ),
  );
  assert.equal(
    await prisma.memoryTombstone.count({
      where: { kind: "SESSION", agentPrincipalId: principal.id },
    }),
    2,
    "every retained HMAC version gets a session tombstone",
  );
  assert.equal(
    (await prisma.memoryCapture.findUniqueOrThrow({ where: { id: secondCapture.id } }))
      .quarantinedAt,
    null,
    "same raw session ID under another principal remains isolated",
  );
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(created.id, rotatedCredential.raw),
        detailParams,
      )
    ).status,
    403,
    "session revocation removes creator raw-detail access before cleanup",
  );
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(created.id, scopedAdminCredential.raw),
        detailParams,
      )
    ).status,
    200,
    "scope-authorized administrators may inspect quarantined capture evidence",
  );

  await revokeMemoryAgentPrincipal(secondPrincipal.id);
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        await tx.memoryCandidate.create({
          data: {
            dedupeKey: `${prefix}-post-revocation-candidate`,
            dedupeKeyVersion: 1,
            hmacAlgorithm: "HMAC-SHA-256",
            title: "Late revoked-principal candidate",
            content: "A late worker cannot publish after principal revocation.",
            recallSummary: "Revoked principals cannot authorize new candidates.",
            confidence: "high",
            restrictedTags: [scopeTag],
            agentPrincipalId: secondPrincipal.id,
            privateScopeTag: scopeTag,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            provenanceEdges: {
              create: [secondPrincipalLineage, scopeLineage!].map((lineage) => ({
                sourceGroupId: `${prefix}-post-revocation-source`,
                lineageStateId: lineage.id,
                generationSnapshot: lineage.generation,
              })),
            },
          },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryCandidate_source_required", "MemoryProvenanceEdge_candidate_source_required" IMMEDIATE',
        );
      }),
    /requires complete active principal-scoped provenance|23514/i,
    "principal revocation defeats late candidate publication",
  );
  const secondDetailParams = { params: Promise.resolve({ id: secondCapture.id }) };
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(secondCapture.id, secondCredential.raw),
        secondDetailParams,
      )
    ).status,
    403,
    "principal revocation removes creator raw-detail access before cleanup",
  );
  assert.equal(
    (
      await getCaptureDetail(
        captureDetailRequest(secondCapture.id, scopedAdminCredential.raw),
        secondDetailParams,
      )
    ).status,
    200,
    "scope-authorized administrators retain principal-revocation review access",
  );

  assert.equal(
    readAutomaticMemoryCaptureConfig({}).ingestionEnabled,
    false,
  );
  const maintenance = await runMemoryMaintenanceBatch({
    workerId: `${prefix}-maintenance`,
    limit: 20,
  });
  assert.ok(maintenance.succeeded >= 2);
  assert.equal(await prisma.memoryCapture.findUnique({ where: { id: created.id } }), null);
  assert.equal(await prisma.memoryCandidate.findUnique({ where: { id: candidate.id } }), null);
  assert.equal(
    (await prisma.memoryCandidate.findUniqueOrThrow({
      where: { id: survivingCandidate.id },
      include: { provenanceEdges: true },
    })).provenanceEdges.every(
      ({ sourceGroupId }) => sourceGroupId === `${prefix}-independent-source`,
    ),
    true,
    "cleanup preserves only a complete independently authorized candidate source group",
  );
  assert.equal(await prisma.memoryRetrievalStat.findUnique({ where: { id: stat.id } }), null);
  assert.equal(
    await prisma.articleRecallEnrichment.findUnique({ where: { articleId: article.id } }),
    null,
  );
  assert.equal(
    await prisma.article.findUnique({ where: { id: generatedDraft.id } }),
    null,
    "cleanup deletes only an unreviewed draft explicitly marked as automatic memory",
  );
  assert.ok(
    (await prisma.article.findUniqueOrThrow({ where: { id: humanDraft.id } }))
      .recallQuarantinedAt,
    "human-authored drafts remain quarantined for explicit privacy review",
  );
  assert.equal(
    await prisma.memoryPrivacyReview.count({ where: { articleId: humanDraft.id } }),
    1,
  );
  assert.ok(
    (await prisma.article.findUniqueOrThrow({ where: { id: manualDraft.id } }))
      .recallQuarantinedAt,
    "manual drafts remain quarantined even without a bound human author",
  );
  assert.equal(
    await prisma.memoryPrivacyReview.count({ where: { articleId: manualDraft.id } }),
    1,
  );
  assert.ok(
    (await prisma.article.findUniqueOrThrow({ where: { id: article.id } }))
      .recallQuarantinedAt,
    "reviewed article remains quarantined for human privacy review",
  );
  const retainedDraft = await prisma.article.findUniqueOrThrow({
    where: { id: survivingDraft.id },
    include: { memoryProvenanceEdges: true },
  });
  assert.ok(retainedDraft.recallQuarantinedAt);
  assert.ok(
    retainedDraft.memoryProvenanceEdges.every(
      ({ sourceGroupId }) => sourceGroupId === `${prefix}-draft-independent-source`,
    ),
  );
  assert.equal(
    await prisma.memoryPrivacyReview.count({ where: { articleId: survivingDraft.id } }),
    1,
    "a retained multi-source draft is queued for explicit re-synthesis review",
  );
  await prisma.article.delete({ where: { id: humanDraft.id } });
  await prisma.article.delete({ where: { id: manualDraft.id } });
  await prisma.user.delete({ where: { id: humanAuthor.id } });

  const unrelatedLineage = await prisma.memoryLineageState.create({
    data: {
      kind: "SESSION",
      subjectHash: `${prefix}-unrelated-session`,
      hmacKeyVersion: 1,
      agentPrincipalId: secondPrincipal.id,
    },
  });
  const manualArticle = await prisma.article.create({
    data: {
      title: `${prefix} manual scoped article`,
      slug: `${prefix}-manual-scoped-article`,
      content: "A manually authored scoped article must prevent orphaned scope deletion.",
      status: "draft",
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: {
          sourceGroupId: `${prefix}-unrelated-source`,
          lineageStateId: unrelatedLineage.id,
          generationSnapshot: unrelatedLineage.generation,
        },
      },
    },
  });
  await assert.rejects(
    () => deleteMemoryRestrictedScope(scopeTag),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 409,
      ),
    "scope deletion is blocked while a non-memory article still uses the tag",
  );
  await prisma.article.delete({ where: { id: manualArticle.id } });
  const deletedScope = await deleteMemoryRestrictedScope(scopeTag);
  assert.equal(deletedScope.revokedPrincipals, 2);
  assert.equal(
    (await prisma.memoryAgentPrincipal.findUniqueOrThrow({
      where: { id: secondPrincipal.id },
    })).status,
    "REVOKED",
  );
  assert.deepEqual(
    (await prisma.apiKey.findUniqueOrThrow({ where: { id: secondCredential.key.id } }))
      .allowedScopes,
    [],
  );
  assert.equal(
    await prisma.restrictedScope.findUnique({ where: { tag: scopeTag } }),
    null,
  );
  assert.ok(
    (await prisma.article.findUniqueOrThrow({ where: { id: article.id } }))
      .recallQuarantinedAt,
    "reviewed memory-derived articles remain quarantined for privacy review after scope deletion",
  );
});

function hasImmutableBindingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    message?: unknown;
    cause?: { originalMessage?: unknown };
  };
  return [record.message, record.cause?.originalMessage].some(
    (message) =>
      typeof message === "string" &&
      message.includes("ApiKey agent principal binding is immutable"),
  );
}

function captureDetailRequest(id: string, rawKey: string): NextRequest {
  return new NextRequest(`http://localhost/api/memory/captures/${id}`, {
    headers: { authorization: `Bearer ${rawKey}` },
  });
}

function memoryAdminListRequest(pathname: string, rawKey: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { authorization: `Bearer ${rawKey}` },
  });
}

function memoryAdminJsonRequest(
  pathname: string,
  rawKey: string,
  body?: Record<string, unknown>,
  method = "POST",
): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${rawKey}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assertPrivateNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}
