import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  digestWithActiveKey,
  digestWithAllKeys,
  parseCaptureHmacKeyring,
} from "@/lib/memory/capture/crypto";
import { readAutomaticMemoryCaptureConfig } from "@/lib/memory/capture/config";
import { validateMemoryCaptureRequest } from "@/lib/memory/capture/validation";
import { computeArticleRecallSourceHash } from "@/lib/memory/capture/enrichment";

function encodedKey(fill: number): string {
  return `base64:${Buffer.alloc(32, fill).toString("base64")}`;
}

test("automatic capture ingestion is disabled without configuration", () => {
  assert.deepEqual(readAutomaticMemoryCaptureConfig({}), {
    ingestionEnabled: false,
  });
});

test("enabled capture requires a bounded versioned HMAC keyring", () => {
  assert.throws(
    () => readAutomaticMemoryCaptureConfig({ NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED: "true" }),
    /HMAC_KEYS is required/,
  );

  const keyring = parseCaptureHmacKeyring({
    NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION: "2",
    NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS: JSON.stringify({
      2: encodedKey(2),
      1: encodedKey(1),
    }),
  });
  assert.equal(keyring.activeVersion, 2);
  assert.deepEqual(keyring.keys.map((entry) => entry.version), [2, 1]);
});

test("disabling ingestion retains the maintenance keyring for deletion and expiry", () => {
  const config = readAutomaticMemoryCaptureConfig({
    NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED: "false",
    NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION: "1",
    NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS: JSON.stringify({ 1: encodedKey(4) }),
  });
  assert.equal(config.ingestionEnabled, false);
  assert.equal(config.hmacKeyring?.activeVersion, 1);
});

test("capture HMACs are principal-scoped and domain-separated", () => {
  const keyring = parseCaptureHmacKeyring({
    NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION: "1",
    NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS: JSON.stringify({ 1: encodedKey(3) }),
  });
  const sessionA = digestWithActiveKey(keyring, "session", "principal-a", ["session-1"]);
  const sessionB = digestWithActiveKey(keyring, "session", "principal-b", ["session-1"]);
  const runA = digestWithActiveKey(keyring, "run", "principal-a", ["session-1"]);
  assert.notEqual(sessionA.digest, sessionB.digest);
  assert.notEqual(sessionA.digest, runA.digest);
  assert.equal(sessionA.keyVersion, 1);
});

test("historical HMAC keys support multi-version lookup during rotation", () => {
  const keyring = parseCaptureHmacKeyring({
    NOOSPHERE_MEMORY_CAPTURE_HMAC_ACTIVE_VERSION: "2",
    NOOSPHERE_MEMORY_CAPTURE_HMAC_KEYS: JSON.stringify({
      2: encodedKey(2),
      1: encodedKey(1),
    }),
  });
  const variants = digestWithAllKeys(keyring, "capture-dedupe", "principal-a", ["turn"]);
  assert.deepEqual(variants.map((entry) => entry.keyVersion), [2, 1]);
  assert.ok(variants.every((entry) => /^v\d+:[A-Za-z0-9_-]+$/.test(entry.digest)));
});

test("capture validation rejects identity and lifecycle injection", () => {
  const result = validateMemoryCaptureRequest({
    sourceSessionId: "session-1",
    userText: "The deployment decision should be recorded for tomorrow.",
    assistantText: "We selected the safe rollout and documented the reason.",
    agentId: "spoofed",
    status: "promoted",
  });
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: "Unknown field(s): agentId, status",
  });
});

test("capture validation strips recalled memory and rejects secrets", () => {
  const safe = validateMemoryCaptureRequest({
    sourceSessionId: "session-1",
    sourceRunId: "run-1",
    userText:
      "<noosphere_auto_recall>old memory</noosphere_auto_recall>\nWe decided to retain the private rollout gate.",
    assistantText:
      "The rollout gate remains disabled until the migration verification passes.",
  });
  assert.equal(safe.ok, true);
  if (safe.ok) {
    assert.doesNotMatch(safe.input.userText, /noosphere_auto_recall/);
    assert.ok(safe.input.strippedBlocks.length > 0);
  }

  const token = `noo_${crypto.randomBytes(24).toString("base64url")}`;
  const unsafe = validateMemoryCaptureRequest({
    sourceSessionId: "session-1",
    userText: `Please retain this credential ${token} for later retrieval.`,
    assistantText: "I will not persist secrets in the automatic memory pipeline.",
  });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.match(unsafe.error, /appears to contain a secret/);
});

test("capture validation enforces UTF-8 byte limits", () => {
  const oversizedIdentifier = validateMemoryCaptureRequest({
    sourceSessionId: "ä".repeat(300),
    userText: "The durable deployment decision must remain available for later work.",
    assistantText: "The private rollout gate remains disabled until verification passes.",
  });
  assert.equal(oversizedIdentifier.ok, false);
  if (!oversizedIdentifier.ok) {
    assert.equal(oversizedIdentifier.error, "sourceSessionId is too long");
  }

  const oversizedText = validateMemoryCaptureRequest({
    sourceSessionId: "session-1",
    userText: `Remember the durable decision ${"ä".repeat(6_000)}`,
    assistantText: "The private rollout gate remains disabled until verification passes.",
  });
  assert.equal(oversizedText.ok, false);
  if (!oversizedText.ok) assert.equal(oversizedText.error, "userText is too long");
});

test("article recall source hashes are canonical and scope-independent", () => {
  const first = computeArticleRecallSourceHash({
    title: "  Durable plan ",
    excerpt: "Short summary\r\n",
    content: "Line one.\r\nLine two.\n",
    tags: ["beta", "alpha", "alpha"],
    sourceType: "manual",
  });
  const equivalent = computeArticleRecallSourceHash({
    title: "Durable plan",
    excerpt: "Short summary",
    content: "Line one.\nLine two.",
    tags: ["alpha", "beta"],
    sourceType: "manual",
  });
  const changed = computeArticleRecallSourceHash({
    title: "Durable plan",
    excerpt: "Short summary",
    content: "Line one changed.\nLine two.",
    tags: ["alpha", "beta"],
    sourceType: "manual",
  });
  assert.equal(first, equivalent);
  assert.notEqual(first, changed);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("Phase A Article checks are added without an immediate table validation scan", async () => {
  const migration = await readFile(
    path.join(
      process.cwd(),
      "prisma/migrations/20260715132950_automatic_memory_phase_a/migration.sql",
    ),
    "utf8",
  );

  for (const constraint of [
    "Article_recallQuarantine_reason",
    "Article_memoryRevocationGeneration_nonnegative",
  ]) {
    const start = migration.indexOf(`ADD CONSTRAINT "${constraint}"`);
    assert.notEqual(start, -1, `${constraint} must exist`);
    const nextConstraint = migration.indexOf("ADD CONSTRAINT", start + 1);
    const nextSemicolon = migration.indexOf(";", start);
    const end =
      nextConstraint !== -1 && nextConstraint < nextSemicolon
        ? nextConstraint
        : nextSemicolon + 1;
    const clause = migration.slice(start, end).trim().replace(/,$/, "");
    assert.match(clause, /NOT VALID;?$/);
  }
});

test("candidate source-edge validation batches dependent candidates with covering indexes", async () => {
  const migration = await readFile(
    path.join(
      process.cwd(),
      "prisma/migrations/20260715132950_automatic_memory_phase_a/migration.sql",
    ),
    "utf8",
  );

  assert.doesNotMatch(
    migration,
    /FOR dependent_candidate IN/,
    "deferred edge validation must not call the candidate validator in a row loop",
  );
  assert.match(
    migration,
    /assert_memory_capture_group_candidates_have_source/,
    "capture-edge changes must use the set-based dependent-candidate validator",
  );
  assert.match(
    migration,
    /CREATE INDEX "MemoryProvEdge_capture_lineage_generation_idx"/,
    "capture source-group matching requires a composite provenance index",
  );
  assert.match(
    migration,
    /CREATE INDEX "MemoryCandidate_sourceCaptureId_idx"/,
    "dependent-candidate lookup must remain indexed",
  );
});
