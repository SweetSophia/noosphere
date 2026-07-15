import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { Permissions } from "@prisma/client";
import { Pool, type PoolClient } from "pg";
import { prisma } from "@/lib/prisma";
import {
  createApiKeyRecord,
  updateApiKeyRecord,
} from "@/lib/api/key-mutations";
import type { CaptureHmacKeyring } from "@/lib/memory/capture/crypto";
import {
  createMemoryAgentPrincipal,
  deleteMemoryRestrictedScope,
  revokeMemoryAgentPrincipal,
  revokeMemorySession,
} from "@/lib/memory/capture/lifecycle";
import { PrismaMemoryCaptureRepository } from "@/lib/memory/capture/repository";
import { NoosphereProvider } from "@/lib/memory/noosphere";

const prefix = `phase-a-race-${crypto.randomUUID()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let integrationLockClient: PoolClient | undefined;
const repository = new PrismaMemoryCaptureRepository();
const keyring: CaptureHmacKeyring = {
  activeVersion: 1,
  keys: [{ version: 1, key: Buffer.alloc(32, 0x31) }],
};

before(async () => {
  integrationLockClient = await pool.connect();
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
    await prisma.memoryAgentPrincipal.deleteMany({ where: { id: { in: principalIds } } });
  }
  await prisma.memoryLineageState.deleteMany({
    where: { kind: "SCOPE", subjectHash: { startsWith: `scope:${prefix}` } },
  });
  if (topicIds.length > 0) {
    await prisma.topic.deleteMany({ where: { id: { in: topicIds } } });
  }
  await prisma.restrictedScope.deleteMany({ where: { tag: { startsWith: prefix } } });
  await prisma.$disconnect();
  if (integrationLockClient) {
    await integrationLockClient.query("SELECT pg_advisory_unlock($1::int)", [
      1_621_507_015,
    ]);
    integrationLockClient.release();
  }
  await pool.end();
});

test("a principal revocation waiting behind the key boundary defeats capture", async () => {
  const scopeTag = `${prefix}-principal-private`;
  await prisma.restrictedScope.create({ data: { tag: scopeTag } });
  const principal = await createMemoryAgentPrincipal({
    name: `${prefix} principal-race`,
    privateScopeTag: scopeTag,
  });
  const credential = await createApiKeyRecord({
    name: `${prefix} principal-race-key`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag],
    agentPrincipalId: principal.id,
  });

  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query('SELECT id FROM "ApiKey" WHERE id = $1 FOR UPDATE', [
      credential.key.id,
    ]);
    const capture = repository
      .createOrIncrement({
        auth: { keyId: credential.key.id, agentPrincipalId: principal.id },
        capture: {
          sourceSessionId: "principal-race-session",
          userText: "Remember the durable private rollout decision for later work.",
          assistantText: "The rollout decision remains private until verification completes.",
          strippedBlocks: [],
        },
        keyring,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await waitForLockWaiters(blocker, 1);

    await revokeMemoryAgentPrincipal(principal.id);
    await blocker.query("COMMIT");
    const result = await capture;
    assert.ok("error" in result, "capture must fail after revocation wins serialization");
    assert.equal(
      await prisma.memoryCapture.count({ where: { agentPrincipalId: principal.id } }),
      0,
    );
    assert.equal(
      await prisma.memoryTombstone.count({
        where: { kind: "PRINCIPAL", agentPrincipalId: principal.id },
      }),
      1,
    );
  } finally {
    await rollbackIfNeeded(blocker);
    blocker.release();
  }
});

test("same-principal concurrent duplicates serialize to one capture", async () => {
  const scopeTag = `${prefix}-dedupe-private`;
  await prisma.restrictedScope.create({ data: { tag: scopeTag } });
  const principal = await createMemoryAgentPrincipal({
    name: `${prefix} dedupe-race`,
    privateScopeTag: scopeTag,
  });
  const credentials = await Promise.all(
    ["one", "two"].map((suffix) =>
      createApiKeyRecord({
        name: `${prefix} dedupe-race-key-${suffix}`,
        permissions: Permissions.WRITE,
        allowedScopes: [scopeTag],
        agentPrincipalId: principal.id,
      }),
    ),
  );
  const capture = {
    sourceSessionId: "dedupe-race-session",
    sourceRunId: "dedupe-race-run",
    userText: "Remember the concurrency-safe dedupe contract.",
    assistantText: "Concurrent duplicates must increment one durable capture.",
    strippedBlocks: [] as string[],
  };

  const blocker = await pool.connect();
  let pending: Array<ReturnType<typeof repository.createOrIncrement>> = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      'SELECT id FROM "MemoryAgentPrincipal" WHERE id = $1 FOR UPDATE',
      [principal.id],
    );

    pending = credentials.map((credential) =>
      repository.createOrIncrement({
        auth: { keyId: credential.key.id, agentPrincipalId: principal.id },
        capture,
        keyring,
      }),
    );
    // Distinct keys remove the earlier ApiKey-lock serialization shortcut. Both
    // transactions must reach the shared principal lock statement before release.
    await waitForLockWaiters(blocker, 1);
    await waitForPrincipalBoundaryWaiters(blocker, 2);
    await blocker.query("COMMIT");

    const results = await Promise.all(pending);
    assert.equal(new Set(results.map(({ id }) => id)).size, 1);
    assert.deepEqual(
      results.map(({ occurrenceCount }) => occurrenceCount).sort((a, b) => a - b),
      [1, 2],
    );
    assert.equal(results.filter(({ created }) => created).length, 1);

    const stored = await prisma.memoryCapture.findMany({
      where: { agentPrincipalId: principal.id },
      select: { occurrenceCount: true },
    });
    assert.deepEqual(stored, [{ occurrenceCount: 2 }]);
  } finally {
    await rollbackIfNeeded(blocker);
    blocker.release();
    await Promise.allSettled(pending);
  }
});

test("a queued session revocation defeats concurrent recall hydration", async () => {
  const scopeTag = `${prefix}-recall-private`;
  await prisma.restrictedScope.create({ data: { tag: scopeTag } });
  const topic = await prisma.topic.create({
    data: { name: `${prefix} race topic`, slug: `${prefix}-race-topic` },
  });
  const principal = await createMemoryAgentPrincipal({
    name: `${prefix} recall-race`,
    privateScopeTag: scopeTag,
  });
  const credential = await createApiKeyRecord({
    name: `${prefix} recall-race-key`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag],
    agentPrincipalId: principal.id,
  });
  const sourceSessionId = "recall-race-session";
  const capture = await repository.createOrIncrement({
    auth: { keyId: credential.key.id, agentPrincipalId: principal.id },
    capture: {
      sourceSessionId,
      userText: "Remember the durable recall-race decision for later validation.",
      assistantText: "The recall-race decision remains private and scoped.",
      strippedBlocks: [],
    },
    keyring,
  });
  const stored = await prisma.memoryCapture.findUniqueOrThrow({
    where: { id: capture.id },
    include: { provenanceEdges: { include: { lineageState: true } } },
  });
  const sessionLineage = stored.provenanceEdges.find(
    ({ lineageState }) => lineageState.kind === "SESSION",
  )!.lineageState;
  const article = await prisma.article.create({
    data: {
      title: `${prefix} recall race article`,
      slug: `${prefix}-recall-race-article`,
      content: "Private content must not survive a winning session revocation.",
      status: "reviewed",
      topicId: topic.id,
      restrictedTags: [scopeTag],
      memoryProvenanceEdges: {
        create: stored.provenanceEdges.map(({ lineageState }) => ({
          sourceGroupId: `capture:${capture.id}`,
          lineageStateId: lineageState.id,
          generationSnapshot: lineageState.generation,
        })),
      },
    },
  });

  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      'SELECT id FROM "MemoryLineageState" WHERE id = $1 FOR UPDATE',
      [sessionLineage.id],
    );
    const revocation = revokeMemorySession({
      principalId: principal.id,
      sourceSessionId,
      keyring,
    });
    await waitForLockWaiters(blocker, 1);
    const hydration = new NoosphereProvider({ allowedScopes: [scopeTag] }).getById(
      article.id,
    );
    // Let hydration enter Prisma's transaction queue while the earlier
    // revocation remains blocked. We intentionally do not require a second
    // PostgreSQL lock waiter: under suite-level concurrency the adapter may be
    // waiting for a pool slot, which still preserves the required ordering.
    await new Promise<void>((resolve) => setImmediate(resolve));

    await blocker.query("COMMIT");
    await revocation;
    assert.equal(await hydration, null);
    assert.ok(
      (await prisma.article.findUniqueOrThrow({ where: { id: article.id } }))
        .recallQuarantinedAt,
    );
  } finally {
    await rollbackIfNeeded(blocker);
    blocker.release();
  }
});

test("scope deletion cannot be undone by a queued unbound key create", async () => {
  const scopeTag = `${prefix}-create-delete-private`;
  await prisma.restrictedScope.create({ data: { tag: scopeTag } });

  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      'SELECT tag FROM "RestrictedScope" WHERE tag = $1 FOR UPDATE',
      [scopeTag],
    );
    const deletion = deleteMemoryRestrictedScope(scopeTag);
    await waitForLockWaiters(blocker, 1);
    const creation = createApiKeyRecord({
      name: `${prefix} queued create key`,
      permissions: Permissions.WRITE,
      allowedScopes: [scopeTag],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    await blocker.query("COMMIT");
    await deletion;
    const result = await creation;
    assert.ok("error" in result, "key creation must fail after scope deletion wins");
    assert.equal(
      await prisma.apiKey.count({ where: { name: `${prefix} queued create key` } }),
      0,
    );
    assert.equal(await prisma.restrictedScope.findUnique({ where: { tag: scopeTag } }), null);
  } finally {
    await rollbackIfNeeded(blocker);
    blocker.release();
  }
});

test("scope deletion cannot be undone by a queued key scope update", async () => {
  const scopeTag = `${prefix}-update-delete-private`;
  await prisma.restrictedScope.create({ data: { tag: scopeTag } });
  const credential = await createApiKeyRecord({
    name: `${prefix} queued update key`,
    permissions: Permissions.WRITE,
    allowedScopes: [scopeTag],
  });

  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      'SELECT tag FROM "RestrictedScope" WHERE tag = $1 FOR UPDATE',
      [scopeTag],
    );
    const deletion = deleteMemoryRestrictedScope(scopeTag);
    await waitForLockWaiters(blocker, 1);
    const update = updateApiKeyRecord(credential.key.id, {
      allowedScopes: [scopeTag],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    await blocker.query("COMMIT");
    await deletion;
    const result = await update;
    assert.ok("error" in result, "key update must fail after scope deletion wins");
    assert.deepEqual(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: credential.key.id } }))
        .allowedScopes,
      [],
    );
    assert.equal(await prisma.restrictedScope.findUnique({ where: { tag: scopeTag } }), null);
  } finally {
    await rollbackIfNeeded(blocker);
    blocker.release();
  }
});

async function waitForLockWaiters(
  observer: PoolClient,
  minimum: number,
  timeoutMs = 5_000,
): Promise<void> {
  const blockerPid = await observer.query<{ pid: number }>(
    "SELECT pg_backend_pid()::int AS pid",
  );
  const pid = blockerPid.rows[0]!.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
      `,
      [pid],
    );
    if ((result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} database lock waiter(s)`);
}

async function waitForPrincipalBoundaryWaiters(
  observer: PoolClient,
  minimum: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%MemoryAgentPrincipal%'
      `,
    );
    if ((result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} principal-boundary waiter(s)`);
}

async function rollbackIfNeeded(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // COMMIT already ended the transaction.
  }
}
