import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

// This is a bootstrap integration test, not a mock of its SQL decisions. The
// ordinary API test runner supplies a disposable database, just as it does for
// bootstrap-topics.test.ts. Never infer database settings from an env file.
test("bootstrap full-access provisioning preserves existing credential authority", { timeout: 90_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must name the disposable test database");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const runId = randomUUID();
  const keyHashes: string[] = [];
  const emails: string[] = [];
  const principals: string[] = [];

  async function keyRow(key: string) {
    return (await pool.query('SELECT * FROM "ApiKey" WHERE "keyHash" = $1', [hash(key)])).rows[0];
  }

  function bootstrap(key: string, settings: Record<string, string | undefined> = {}) {
    const email = `bootstrap-scope-${randomUUID()}@noosphere.test`;
    emails.push(email);
    keyHashes.push(hash(key));
    const result = spawnSync(process.execPath, [resolve(repoRoot, "docker/bootstrap.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 12_000,
      // Do not inherit a developer's real bootstrap, reset, provider or Redis
      // settings; all credentials below are synthetic and scoped to this run.
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        DATABASE_URL: process.env.DATABASE_URL,
        NOOSPHERE_ADMIN_EMAIL: email,
        NOOSPHERE_ADMIN_PASSWORD: `fixture-${runId}`,
        NOOSPHERE_BOOTSTRAP_API_KEY: key,
        NOOSPHERE_API_KEY_NAME: `fixture-${runId}`,
        ...settings,
      },
    });
    assert.equal(result.error, undefined, "bootstrap child must finish within its deadline");
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes(key), "bootstrap must not print the raw API key");
    assert.ok(!output.includes(`fixture-${runId}`), "bootstrap must not print the supplied password");
    return { result, output, email };
  }

  async function existingKey(permissions: string, scopes: string[], revoked = false, bound = false) {
    const key = `noo_fixture_${randomUUID().replaceAll("-", "")}`;
    const principal = bound ? randomUUID() : null;
    if (principal) {
      principals.push(principal);
      await pool.query(
        'INSERT INTO "MemoryAgentPrincipal" (id, name, "privateScopeTag", "updatedAt") VALUES ($1, $2, $3, NOW())',
        [principal, `fixture-${principal}`, `scope-${principal}`],
      );
    }
    keyHashes.push(hash(key));
    await pool.query(
      `INSERT INTO "ApiKey" (id, name, "keyHash", "keyPrefix", permissions, "allowedScopes", "revokedAt", "agentPrincipalId")
       VALUES ($1, $2, $3, $4, $5::"Permissions", $6::text[], $7, $8)`,
      [randomUUID(), `preserve-${runId}`, hash(key), key.slice(0, 8), permissions, scopes,
        revoked ? new Date("2026-01-01T00:00:00Z") : null, principal],
    );
    return key;
  }

  async function assertRejectedUnchanged(key: string, settings: Record<string, string>, message: RegExp) {
    const before = await keyRow(key);
    const { result, output, email } = bootstrap(key, settings);
    assert.equal(result.status, 1, "incompatible reuse must fail, not time out or crash");
    assert.match(output, message);
    assert.deepEqual(await keyRow(key), before, "all existing key fields must be preserved");
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM "User" WHERE email = $1', [email]);
    assert.equal(count.rows[0].count, 0, "failure must roll back the newly inserted admin user");
  }

  try {
    for (const flag of [undefined, "false", "true"]) {
      await t.test(`new ADMIN key, full-access setting ${String(flag)}`, async () => {
        const key = `noo_fixture_${randomUUID().replaceAll("-", "")}`;
        const { result, output } = bootstrap(key, flag === undefined ? {} : { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: flag });
        assert.equal(result.status, 0, output);
        const row = await keyRow(key);
        assert.equal(row.permissions, "ADMIN");
        assert.deepEqual(row.allowedScopes, flag === "true" ? ["*"] : []);
        assert.equal(row.revokedAt, null);
        assert.equal(row.agentPrincipalId, null);
        const metadata = JSON.parse(result.stdout.trim());
        assert.equal(metadata.apiKeyCreated, true);
        assert.equal(metadata.fullAccess, flag === "true");
      });
    }

    await t.test("active full-scope ADMIN reuse is idempotent and preserves extra scopes and metadata", async () => {
      const key = await existingKey("ADMIN", ["*", "private-fixture"]);
      const before = await keyRow(key);
      for (let attempt = 0; attempt < 2; attempt++) {
        const { result, output } = bootstrap(key, { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "true" });
        assert.equal(result.status, 0, output);
        assert.deepEqual(await keyRow(key), before);
        const metadata = JSON.parse(result.stdout.trim());
        assert.equal(metadata.apiKeyCreated, false);
        assert.equal(metadata.fullAccess, true);
      }
    });

    for (const permissions of ["READ", "WRITE", "ADMIN"]) {
      for (const scopes of [[], ["private-fixture"], ["admin:*"]]) {
        await t.test(`full-access reuse rejects ${permissions} ${JSON.stringify(scopes)} without expansion`, async () => {
          const key = await existingKey(permissions, scopes);
          await assertRejectedUnchanged(key, { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "true" }, /preserved unchanged/);
        });
      }
    }
    for (const permissions of ["READ", "WRITE"]) {
      await t.test(`literal wildcard does not upgrade ${permissions} permission`, async () => {
        const key = await existingKey(permissions, ["*"]);
        await assertRejectedUnchanged(key, { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "true" }, /preserved unchanged/);
      });
    }
    for (const flag of ["false", "true"]) {
      await t.test(`revoked full-scope ADMIN remains revoked with opt-in ${flag}`, async () => {
        const key = await existingKey("ADMIN", ["*"], true);
        await assertRejectedUnchanged(key, { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: flag }, /not reactivated/);
      });
    }
    await t.test("principal-bound wildcard ADMIN cannot be repurposed as bootstrap authority", async () => {
      const key = await existingKey("ADMIN", ["*"], false, true);
      await assertRejectedUnchanged(key, { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "true" }, /preserved unchanged/);
    });
    for (const permissions of ["READ", "WRITE", "ADMIN"]) {
      await t.test(`direct non-opt-in reuse preserves scoped ${permissions}, including effective permission output`, async () => {
        const key = await existingKey(permissions, ["private-fixture"]);
        const before = await keyRow(key);
        const { result, output } = bootstrap(key);
        assert.equal(result.status, 0, output);
        assert.deepEqual(await keyRow(key), before);
        const metadata = JSON.parse(result.stdout.trim());
        assert.equal(metadata.permissions, permissions);
        assert.equal(metadata.fullAccess, false);
      });
    }
    for (const settings of [
      { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "TRUE" },
      { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "" },
      { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "true", NOOSPHERE_API_KEY_PERMISSIONS: "WRITE" },
      { NOOSPHERE_BOOTSTRAP_FULL_ACCESS: "true", NOOSPHERE_API_KEY_PERMISSIONS: "READ" },
    ]) {
      await t.test(`invalid provisioning configuration rejected before database connection: ${JSON.stringify(settings)}`, async () => {
        const key = `noo_fixture_${randomUUID().replaceAll("-", "")}`;
        const { result, output } = bootstrap(key, { ...settings, DATABASE_URL: "postgresql://fixture@127.0.0.1:1/fixture" });
        assert.equal(result.status, 1);
        assert.match(output, /must be true or false|requires ADMIN permission/);
        assert.doesNotMatch(output, /ECONNREFUSED/);
      });
    }
  } finally {
    await pool.query('DELETE FROM "ApiKey" WHERE "keyHash" = ANY($1::text[])', [keyHashes]);
    await pool.query('DELETE FROM "User" WHERE email = ANY($1::text[])', [emails]);
    await pool.query('DELETE FROM "MemoryAgentPrincipal" WHERE id = ANY($1::text[])', [principals]);
    await pool.end();
  }
});
