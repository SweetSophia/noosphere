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
import {
  createApiKeyRecord,
  rotateApiKeyCredential,
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
        create: [sessionLineage!, principalLineage!, scopeLineage!].map(
          (lineage) => ({
            sourceGroupId,
            lineageStateId: lineage.id,
            generationSnapshot: lineage.generation,
          }),
        ),
      },
    },
  });
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
    limit: 10,
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
