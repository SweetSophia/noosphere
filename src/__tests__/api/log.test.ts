import assert from "node:assert/strict";
import test from "node:test";
import { formatDetailValue } from "@/lib/admin-log-format";
import { parseDateFilter } from "@/lib/log-validation";

test.describe("formatDetailValue", () => {
  test("formats primitive, array, and object detail values for admin log tags", () => {
    assert.equal(formatDetailValue(null), "null");
    assert.equal(formatDetailValue("ready"), "ready");
    assert.equal(formatDetailValue(3), "3");
    assert.equal(formatDetailValue(true), "true");
    assert.equal(formatDetailValue([]), "[]");
    assert.equal(formatDetailValue(["a", 2, null]), "a, 2, null");
    assert.equal(formatDetailValue([[1, 2], [3]]), "1, 2, 3");
    assert.equal(formatDetailValue({ byType: { stale: 2 } }), '{"byType":{"stale":2}}');
  });
});

test.describe("parseDateFilter", () => {
  // ── Both params null / no filter applied ────────────────────────────────

  test("returns ok with no dates when both params are null", () => {
    const result = parseDateFilter(null, null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.from, undefined);
    assert.equal(result.to, undefined);
  });

  test("returns ok with no dates when from is null and to is empty string", () => {
    // Mixed: from=null, to="" (both treated as missing)
    const r = parseDateFilter(null, "");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.from, undefined);
    assert.equal(r.to, undefined);
  });

  // ── Empty string handling ────────────────────────────────────────────────

  test("treats empty string '' as missing (not an error)", () => {
    // Empty string is a common "present but blank" case from URL params
    const result = parseDateFilter("", "");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.from, undefined);
    assert.equal(result.to, undefined);
  });

  test("treats empty string for 'from' while 'to' is valid", () => {
    const result = parseDateFilter("", "2024-06-01T00:00:00Z");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.from, undefined);
    assert.ok(result.to instanceof Date);
  });

  test("treats empty string for 'to' while 'from' is valid", () => {
    const result = parseDateFilter("2024-01-01T00:00:00Z", "");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.from instanceof Date);
    assert.equal(result.to, undefined);
  });

  // ── Valid ISO date strings ──────────────────────────────────────────────

  test("accepts valid ISO 8601 date for 'from'", () => {
    const result = parseDateFilter("2024-06-01T00:00:00Z", null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.from instanceof Date);
    assert.equal(result.from?.toISOString(), "2024-06-01T00:00:00.000Z");
    assert.equal(result.to, undefined);
  });

  test("accepts valid ISO 8601 date for 'to'", () => {
    const result = parseDateFilter(null, "2024-12-31T23:59:59Z");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.from, undefined);
    assert.ok(result.to instanceof Date);
    assert.equal(result.to?.toISOString(), "2024-12-31T23:59:59.000Z");
  });

  test("accepts both 'from' and 'to' valid ISO dates", () => {
    const result = parseDateFilter("2024-01-01T00:00:00Z", "2024-12-31T23:59:59Z");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.from instanceof Date);
    assert.ok(result.to instanceof Date);
    assert.equal(result.from?.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(result.to?.toISOString(), "2024-12-31T23:59:59.000Z");
  });

  test("accepts date-only format (YYYY-MM-DD)", () => {
    const result = parseDateFilter("2024-06-01", null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.from instanceof Date);
  });

  // ── Invalid date strings ────────────────────────────────────────────────

  test("rejects invalid 'from' date string with 400-style error", () => {
    const result = parseDateFilter("not-a-date", null);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "Invalid 'from' date format");
  });

  test("rejects invalid 'to' date string with 400-style error", () => {
    const result = parseDateFilter(null, "also-not-a-date");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "Invalid 'to' date format");
  });

  test("rejects gibberish date strings", () => {
    const r1 = parseDateFilter("abcdef", null);
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.equal(r1.error, "Invalid 'from' date format");

    const r2 = parseDateFilter(null, "hello-world");
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.equal(r2.error, "Invalid 'to' date format");
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  test("accepts valid ISO epoch-0 date string for 'from'", () => {
    // Use the ISO string for Unix epoch 0, not the raw number "0" (which JS parses as a year).
    const result = parseDateFilter("1970-01-01T00:00:00.000Z", null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.from instanceof Date);
    assert.equal(result.from?.toISOString(), "1970-01-01T00:00:00.000Z");
  });

  test("accepts valid ISO epoch-0 date string for 'to'", () => {
    const result = parseDateFilter(null, "1970-01-01T00:00:00.000Z");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.to instanceof Date);
    assert.equal(result.to?.toISOString(), "1970-01-01T00:00:00.000Z");
  });

  test("rejects strings that are too long (> 100 chars)", () => {
    const longString = "a".repeat(101);
    const r1 = parseDateFilter(longString, null);
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.equal(r1.error, "from date string too long");

    const r2 = parseDateFilter(null, longString);
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.equal(r2.error, "to date string too long");
  });

  test("rejects 100-char invalid string at length boundary (not length error)", () => {
    const maxString = "a".repeat(100);
    const r = parseDateFilter(maxString, null);
    // 'aaaaa...' (100 chars) is not a valid date, but should NOT fail length check
    // It should fail date parsing instead
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "Invalid 'from' date format");
  });

  test("accepts valid date string at exactly 100 characters", () => {
    // Use extended year format (+002024) with fractional seconds to pad to 100 chars.
    // Base: "+002024-06-01T00:00:00." (23 chars) + "Z" (1 char) = 24 chars fixed.
    // Remaining 76 chars: fractional seconds "111..." (76 ones) are valid ISO 8601.
    const paddedDate = "+002024-06-01T00:00:00." + "1".repeat(76) + "Z";
    assert.equal(paddedDate.length, 100);
    const result = parseDateFilter(paddedDate, null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.from instanceof Date);
  });
});
