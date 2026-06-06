import assert from "node:assert/strict";
import test from "node:test";
import { Permissions } from "@prisma/client";

import { canChangeExistingRestrictedTags } from "@/app/api/import/route";

// Pure-function tests for the declassification gate.
// These pin the contract Copilot Fagan Inspection flagged as C1: session
// callers with `["*"]` allowedScopes (no `keyId`) must be treated the same
// as ADMIN API keys, because `checkRouteAuth` grants every human session
// `allowedScopes: ["*"]` and never sets `keyId`.

test("ADMIN permission grants reclassification", () => {
  assert.equal(
    canChangeExistingRestrictedTags({ permissions: Permissions.ADMIN }),
    true,
  );
});

test("ADMIN role grants reclassification", () => {
  assert.equal(canChangeExistingRestrictedTags({ role: "ADMIN" }), true);
});

test("API key with wildcard scope grants reclassification", () => {
  assert.equal(
    canChangeExistingRestrictedTags({
      keyId: "key_abc",
      permissions: Permissions.WRITE,
      allowedScopes: ["*"],
    }),
    true,
  );
});

test("session caller with wildcard scope grants reclassification (no keyId)", () => {
  // Regression: this was the C1 bug. The old helper only honoured the
  // wildcard when a keyId was present, so EDITOR sessions (no keyId,
  // allowedScopes=["*"]) were incorrectly blocked from reclassifying on
  // overwrite.
  assert.equal(
    canChangeExistingRestrictedTags({
      role: "EDITOR",
      allowedScopes: ["*"],
    }),
    true,
  );
});

test("scoped WRITE key without wildcard is denied reclassification", () => {
  assert.equal(
    canChangeExistingRestrictedTags({
      keyId: "key_abc",
      permissions: Permissions.WRITE,
      allowedScopes: ["health"],
    }),
    false,
  );
});

test("session caller with only restricted scopes is denied reclassification", () => {
  assert.equal(
    canChangeExistingRestrictedTags({
      role: "EDITOR",
      allowedScopes: ["health"],
    }),
    false,
  );
});

test("empty auth shape is denied reclassification", () => {
  assert.equal(canChangeExistingRestrictedTags({}), false);
});
