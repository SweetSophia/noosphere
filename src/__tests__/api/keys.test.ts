import assert from "node:assert/strict";
import test, { after } from "node:test";
import crypto from "crypto";
import { Permissions, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  hashApiKey,
  generateApiKey,
  validateApiKey,
  type ApiKeyValidationClient,
  type ApiKeyValidationRecord,
} from "@/lib/api/keys";

after(async () => {
  await prisma.$disconnect();
});

test("generateApiKey returns a noo_ prefixed key", () => {
  const key = generateApiKey("test-agent");
  assert.ok(key.raw.startsWith("noo_"), "raw key should start with noo_");
  assert.equal(key.hash, hashApiKey(key.raw));
  assert.equal(key.prefix, key.raw.slice(0, 8));
  assert.equal(key.hash.length, 64); // SHA-256 hex
});

test("generateApiKey produces unique keys", () => {
  const a = generateApiKey("a");
  const b = generateApiKey("b");
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
});

test("hashApiKey is deterministic", () => {
  const raw = "noo_test-key-123";
  const hash1 = hashApiKey(raw);
  const hash2 = hashApiKey(raw);
  assert.equal(hash1, hash2);
  assert.equal(hash1, crypto.createHash("sha256").update(raw).digest("hex"));
});

test("validateApiKey looks up by unique key hash and updates active keys", async () => {
  const raw = "noo_test-key-active";
  const expectedHash = hashApiKey(raw);
  let findUniqueArgs: Prisma.ApiKeyFindUniqueArgs | undefined;
  let updateManyArgs: Prisma.ApiKeyUpdateManyArgs | undefined;
  const apiKeys: ApiKeyValidationClient = {
    async findUnique(args) {
      findUniqueArgs = args;
      return {
        id: "key-active",
        name: "Active test key",
        permissions: Permissions.READ,
        allowedScopes: ["scope-a"],
        agentPrincipalId: "principal-a",
        revokedAt: null,
      };
    },
    async updateMany(args) {
      updateManyArgs = args;
      return { count: 1 };
    },
  };

  const result = await validateApiKey(raw, apiKeys);

  assert.deepEqual(findUniqueArgs, { where: { keyHash: expectedHash } });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.keyId, "key-active");
  assert.equal(result.name, "Active test key");
  assert.equal(result.permissions, Permissions.READ);
  assert.deepEqual(result.allowedScopes, ["scope-a"]);
  assert.equal(result.agentPrincipalId, "principal-a");
  assert.ok(updateManyArgs);
  const updateWhere: Prisma.ApiKeyUpdateManyArgs["where"] = updateManyArgs.where;
  assert.equal(updateWhere?.id, "key-active");
  assert.ok(Array.isArray(updateWhere?.OR));
  const [neverUsedBranch, staleBranch] = updateWhere.OR;
  assert.deepEqual(neverUsedBranch, { lastUsedAt: null });
  assert.ok(staleBranch?.lastUsedAt && typeof staleBranch.lastUsedAt === "object");
  assert.ok("lt" in staleBranch.lastUsedAt);
  assert.ok(staleBranch.lastUsedAt.lt instanceof Date);
  assert.ok(updateManyArgs.data?.lastUsedAt instanceof Date);
});

test("validateApiKey rejects revoked records after unique hash lookup", async () => {
  const raw = "noo_test-key-revoked";
  const expectedHash = hashApiKey(raw);
  let findUniqueArgs: Prisma.ApiKeyFindUniqueArgs | undefined;
  let updateCalled = false;
  const apiKeys: ApiKeyValidationClient = {
    async findUnique(args) {
      findUniqueArgs = args;
      const record: ApiKeyValidationRecord = {
        id: "key-revoked",
        name: "Revoked test key",
        permissions: Permissions.ADMIN,
        allowedScopes: ["*"],
        agentPrincipalId: null,
        revokedAt: new Date(),
      };
      return record;
    },
    async updateMany() {
      updateCalled = true;
      return { count: 1 };
    },
  };

  const result = await validateApiKey(raw, apiKeys);

  assert.deepEqual(findUniqueArgs, { where: { keyHash: expectedHash } });
  assert.deepEqual(result, { valid: false });
  assert.equal(updateCalled, false);
});

test("validateApiKey rejects missing key hashes without updating lastUsedAt", async () => {
  const raw = "noo_test-key-missing";
  const expectedHash = hashApiKey(raw);
  let findUniqueArgs: Prisma.ApiKeyFindUniqueArgs | undefined;
  let updateCalled = false;
  const apiKeys: ApiKeyValidationClient = {
    async findUnique(args) {
      findUniqueArgs = args;
      return null;
    },
    async updateMany() {
      updateCalled = true;
      return { count: 1 };
    },
  };

  const result = await validateApiKey(raw, apiKeys);

  assert.deepEqual(findUniqueArgs, { where: { keyHash: expectedHash } });
  assert.deepEqual(result, { valid: false });
  assert.equal(updateCalled, false);
});

test("validateApiKey propagates lookup errors", async () => {
  const expected = new Error("lookup failed");
  const apiKeys: ApiKeyValidationClient = {
    async findUnique() {
      throw expected;
    },
    async updateMany() {
      return { count: 0 };
    },
  };

  await assert.rejects(() => validateApiKey("noo_lookup-error", apiKeys), expected);
});

test("validateApiKey propagates last-used update errors", async () => {
  const expected = new Error("update failed");
  const apiKeys: ApiKeyValidationClient = {
    async findUnique() {
      return {
        id: "key-update-error",
        name: "Update error test key",
        permissions: Permissions.READ,
        allowedScopes: [],
        agentPrincipalId: null,
        revokedAt: null,
      };
    },
    async updateMany() {
      throw expected;
    },
  };

  await assert.rejects(() => validateApiKey("noo_update-error", apiKeys), expected);
});

test("validateApiKey stays valid when last-used update is debounced", async () => {
  const apiKeys: ApiKeyValidationClient = {
    async findUnique() {
      return {
        id: "key-debounced",
        name: "Debounced test key",
        permissions: Permissions.READ,
        allowedScopes: [],
        agentPrincipalId: null,
        revokedAt: null,
      };
    },
    async updateMany() {
      return { count: 0 };
    },
  };

  const result = await validateApiKey("noo_debounced", apiKeys);

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.keyId, "key-debounced");
  assert.equal(result.name, "Debounced test key");
});

test("validateApiKey rejects a real key after it is revoked", async () => {
  const runId = crypto.randomUUID();
  const raw = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  const createdKey = await prisma.apiKey.create({
    data: {
      name: `test-issue193-${runId}`,
      keyHash: hashApiKey(raw),
      keyPrefix: raw.slice(0, 8),
      permissions: Permissions.READ,
      allowedScopes: [],
    },
  });

  try {
    const activeResult = await validateApiKey(raw);
    assert.equal(activeResult.valid, true);
    if (!activeResult.valid) return;
    assert.equal(activeResult.keyId, createdKey.id);
    assert.equal(activeResult.name, createdKey.name);

    await prisma.apiKey.update({
      where: { id: createdKey.id },
      data: { revokedAt: new Date() },
    });

    assert.deepEqual(await validateApiKey(raw), { valid: false });
  } finally {
    await prisma.apiKey.delete({ where: { id: createdKey.id } }).catch(() => undefined);
  }
});
