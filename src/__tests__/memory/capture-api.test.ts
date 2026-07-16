import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCaptureStatus } from "@prisma/client";
import { executeMemoryCaptureRequest } from "@/lib/memory/capture/api";
import type { MemoryCaptureRepository } from "@/lib/memory/capture/repository";

const keyring = {
  activeVersion: 1,
  keys: [{ version: 1, key: Buffer.alloc(32, 0x44) }],
};
const validBody = {
  sourceSessionId: "session-1",
  userText: "Remember this durable architectural decision for the next session.",
  assistantText: "The architectural decision is recorded as a private observation.",
};

test("capture API stays disabled by default before validating request content", async () => {
  let called = false;
  const repository: MemoryCaptureRepository = {
    async createOrIncrement() {
      called = true;
      throw new Error("must not be called");
    },
  };
  const result = await executeMemoryCaptureRequest(
    { ...validBody, agentPrincipalId: "attacker-controlled" },
    {
      auth: { keyId: "key-1", agentPrincipalId: "principal-1" },
      config: { ingestionEnabled: false },
      repository,
    },
  );
  assert.equal(result.status, 503);
  assert.equal(called, false);
});

test("capture API requires the immutable server-derived principal binding", async () => {
  const result = await executeMemoryCaptureRequest(validBody, {
    auth: { keyId: "key-1", agentPrincipalId: null },
    config: { ingestionEnabled: true, hmacKeyring: keyring },
  });
  assert.equal(result.status, 403);
});

test("capture API rejects client-supplied identity and lifecycle fields", async () => {
  const result = await executeMemoryCaptureRequest(
    { ...validBody, privateScopeTag: "fake-private-scope" },
    {
      auth: { keyId: "key-1", agentPrincipalId: "principal-1" },
      config: { ingestionEnabled: true, hmacKeyring: keyring },
    },
  );
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Unknown field/);
});

test("capture API returns an asynchronous status resource", async () => {
  const repository: MemoryCaptureRepository = {
    async createOrIncrement(input) {
      assert.equal(input.auth.keyId, "key-1");
      assert.equal(input.auth.agentPrincipalId, "principal-1");
      return {
        id: "capture-1",
        status: MemoryCaptureStatus.PENDING,
        occurrenceCount: 1,
        created: true,
      };
    },
  };
  const result = await executeMemoryCaptureRequest(validBody, {
    auth: { keyId: "key-1", agentPrincipalId: "principal-1" },
    config: { ingestionEnabled: true, hmacKeyring: keyring },
    repository,
  });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, {
    accepted: true,
    id: "capture-1",
    captureStatus: MemoryCaptureStatus.PENDING,
    occurrenceCount: 1,
    duplicate: false,
    statusUrl: "/api/memory/captures/capture-1",
  });
});
