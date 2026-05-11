import assert from "node:assert/strict";
import test from "node:test";
import { parsePagination } from "@/lib/pagination";

function mockSearchParams(entries: Record<string, string>) {
  return {
    get: (key: string) => entries[key] ?? null,
  };
}

test("parsePagination uses defaults", () => {
  const result = parsePagination(mockSearchParams({}));
  assert.equal(result.page, 1);
  assert.equal(result.limit, 20);
  assert.equal(result.offset, 0);
});

test("parsePagination respects provided values", () => {
  const result = parsePagination(mockSearchParams({ page: "3", limit: "50" }));
  assert.equal(result.page, 3);
  assert.equal(result.limit, 50);
  assert.equal(result.offset, 100);
});

test("parsePagination clamps limit to max", () => {
  const result = parsePagination(mockSearchParams({ limit: "500" }), { maxLimit: 100 });
  assert.equal(result.limit, 100);
});

test("parsePagination enforces minimums", () => {
  const result = parsePagination(mockSearchParams({ page: "0", limit: "-5" }));
  assert.equal(result.page, 1);
  assert.equal(result.limit, 1);
});

test("parsePagination handles NaN gracefully", () => {
  const result = parsePagination(mockSearchParams({ page: "abc", limit: "def" }));
  assert.equal(result.page, 1);
  assert.equal(result.limit, 20);
});
