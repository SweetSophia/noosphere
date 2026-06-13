import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  normalizeRestrictedTagsForCaller,
  resolveImportRestrictedTags,
  resolvePatchRestrictedTags,
  resolveRestrictedTagsForCaller,
  validateRestrictedTagsExist,
  type RestrictedScopeLookup,
} from "@/lib/api/restricted-scopes";

// ─── normalizeRestrictedTagsForCaller ───────────────────────────────────────

describe("normalizeRestrictedTagsForCaller", () => {
  test("returns empty array when value is undefined and admin scope", () => {
    const result = normalizeRestrictedTagsForCaller(undefined, ["*"]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("returns empty array when value is null and admin scope", () => {
    const result = normalizeRestrictedTagsForCaller(null, ["*"]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("rejects non-array value", () => {
    const result = normalizeRestrictedTagsForCaller("not-an-array", ["*"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("rejects array with non-string items", () => {
    const result = normalizeRestrictedTagsForCaller([123], ["*"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("rejects array with empty strings", () => {
    const result = normalizeRestrictedTagsForCaller(["valid", "  "], ["*"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("deduplicates tags", () => {
    const result = normalizeRestrictedTagsForCaller(
      ["scope-a", "scope-b", "scope-a"],
      ["*"],
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });

  test("trims whitespace from tags", () => {
    const result = normalizeRestrictedTagsForCaller(
      [" scope-a ", " scope-b "],
      ["*"],
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });

  test("admin scope allows any tags", () => {
    const result = normalizeRestrictedTagsForCaller(
      ["anything", "goes"],
      ["*"],
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["anything", "goes"]);
  });

  test("non-admin caller defaults to own scopes when no tags provided", () => {
    const result = normalizeRestrictedTagsForCaller(undefined, [
      "scope-a",
      "scope-b",
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });

  test("non-admin caller cannot assign scopes they don't have", () => {
    const result = normalizeRestrictedTagsForCaller(["scope-x"], ["scope-a"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.ok(result.error.includes("scope-x"));
  });

  test("non-admin caller can assign scopes they have", () => {
    const result = normalizeRestrictedTagsForCaller(["scope-a"], [
      "scope-a",
      "scope-b",
    ]);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a"]);
  });

  test("caller with undefined scopes and no tags returns empty array", () => {
    const result = normalizeRestrictedTagsForCaller(undefined, undefined);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("caller with empty scopes and no tags returns empty array", () => {
    const result = normalizeRestrictedTagsForCaller(undefined, []);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });
});

// ─── validateRestrictedTagsExist ────────────────────────────────────────────

describe("validateRestrictedTagsExist", () => {
  const mockLookup: RestrictedScopeLookup = async (tags) => {
    const existing = new Set(["scope-a", "scope-b", "scope-c"]);
    return tags.filter((t) => existing.has(t));
  };

  test("returns ok for empty tags", async () => {
    const result = await validateRestrictedTagsExist([], mockLookup);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("returns ok when all tags exist", async () => {
    const result = await validateRestrictedTagsExist(
      ["scope-a", "scope-b"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });

  test("rejects unknown tags", async () => {
    const result = await validateRestrictedTagsExist(
      ["scope-a", "unknown"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.ok(result.error.includes("unknown"));
  });

  test("reports all unknown tags", async () => {
    const result = await validateRestrictedTagsExist(
      ["nope1", "nope2"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("nope1"));
    assert.ok(result.error.includes("nope2"));
  });
});

// ─── resolveRestrictedTagsForCaller ─────────────────────────────────────────

describe("resolveRestrictedTagsForCaller", () => {
  const mockLookup: RestrictedScopeLookup = async (tags) => {
    const existing = new Set(["scope-a", "scope-b"]);
    return tags.filter((t) => existing.has(t));
  };

  test("validates and resolves valid tags for admin", async () => {
    const result = await resolveRestrictedTagsForCaller(
      ["scope-a"],
      ["*"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a"]);
  });

  test("rejects invalid input before lookup", async () => {
    const result = await resolveRestrictedTagsForCaller(
      "not-array",
      ["*"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("rejects non-existent tags after normalization", async () => {
    const result = await resolveRestrictedTagsForCaller(
      ["nonexistent"],
      ["*"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("non-admin with unauthorized scope fails at normalization", async () => {
    const result = await resolveRestrictedTagsForCaller(
      ["scope-b"],
      ["scope-a"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
  });
});

// ─── resolveImportRestrictedTags ────────────────────────────────────────────

describe("resolveImportRestrictedTags", () => {
  const mockLookup: RestrictedScopeLookup = async (tags) => {
    const existing = new Set(["scope-a", "scope-b"]);
    return tags.filter((t) => existing.has(t));
  };

  test("returns empty array when value is undefined (does not auto-assign caller scopes)", async () => {
    const result = await resolveImportRestrictedTags(undefined, ["scope-a"], mockLookup);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("returns empty array when value is null (does not auto-assign caller scopes)", async () => {
    const result = await resolveImportRestrictedTags(null, ["scope-a"], mockLookup);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("returns empty array for empty array value (explicit no restricted tags)", async () => {
    const result = await resolveImportRestrictedTags([], ["scope-a"], mockLookup);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("rejects non-array value", async () => {
    const result = await resolveImportRestrictedTags("not-array", ["*"], mockLookup);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("rejects array with non-string items", async () => {
    const result = await resolveImportRestrictedTags([123], ["*"], mockLookup);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("non-admin caller cannot assign scopes they do not have", async () => {
    const result = await resolveImportRestrictedTags(
      ["scope-b"],
      ["scope-a"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.ok(result.error.includes("scope-b"));
  });

  test("non-admin caller can assign their own scopes", async () => {
    const result = await resolveImportRestrictedTags(
      ["scope-a"],
      ["scope-a", "scope-b"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a"]);
  });

  test("admin scope can assign any existing tag", async () => {
    const result = await resolveImportRestrictedTags(
      ["scope-a", "scope-b"],
      ["*"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });

  test("rejects tags that do not exist in the database", async () => {
    const result = await resolveImportRestrictedTags(
      ["nonexistent"],
      ["*"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.ok(result.error.includes("nonexistent"));
  });

  test("deduplicates repeated tags", async () => {
    const result = await resolveImportRestrictedTags(
      ["scope-a", "scope-a", "scope-b"],
      ["*"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });
});

// ─── resolvePatchRestrictedTags ─────────────────────────────────────────────

describe("resolvePatchRestrictedTags", () => {
  const mockLookup: RestrictedScopeLookup = async (tags) => {
    const existing = new Set(["scope-a", "scope-b"]);
    return tags.filter((t) => existing.has(t));
  };

  test("rejects undefined because PATCH only resolves present fields", async () => {
    const result = await resolvePatchRestrictedTags(undefined, ["scope-a"], mockLookup);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("rejects null to preserve the PATCH API contract", async () => {
    const result = await resolvePatchRestrictedTags(null, ["scope-a"], mockLookup);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("returns empty array for empty array value (explicit declassify, no auto-assign)", async () => {
    const result = await resolvePatchRestrictedTags([], ["scope-a"], mockLookup);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
  });

  test("rejects non-array value", async () => {
    const result = await resolvePatchRestrictedTags("not-array", ["*"], mockLookup);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("rejects array with non-string items", async () => {
    const result = await resolvePatchRestrictedTags([123], ["*"], mockLookup);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test("non-admin caller cannot assign scopes they do not have", async () => {
    const result = await resolvePatchRestrictedTags(
      ["scope-b"],
      ["scope-a"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.ok(result.error.includes("scope-b"));
  });

  test("non-admin caller can assign their own scopes", async () => {
    const result = await resolvePatchRestrictedTags(
      ["scope-a"],
      ["scope-a", "scope-b"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a"]);
  });

  test("admin scope can assign any existing tag", async () => {
    const result = await resolvePatchRestrictedTags(
      ["scope-a", "scope-b"],
      ["*"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-b"]);
  });

  test("rejects tags that do not exist in the database", async () => {
    const result = await resolvePatchRestrictedTags(
      ["nonexistent"],
      ["*"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.equal(
      result.error,
      "Unknown restricted tag(s): nonexistent. Valid tags: ",
    );
  });

  test("preserves repeated tags to keep PATCH storage behavior unchanged", async () => {
    const result = await resolvePatchRestrictedTags(
      ["scope-a", "scope-a", "scope-b"],
      ["*"],
      mockLookup,
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, ["scope-a", "scope-a", "scope-b"]);
  });

  test("does not trim whitespace before validating tags", async () => {
    const result = await resolvePatchRestrictedTags(
      [" scope-a "],
      ["*"],
      mockLookup,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.equal(
      result.error,
      "Unknown restricted tag(s):  scope-a . Valid tags: ",
    );
  });
});
