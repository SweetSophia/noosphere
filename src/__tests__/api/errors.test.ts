import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { NextResponse } from "next/server";
import {
  apiError,
  withApiErrorBoundary,
  withRequestId,
} from "@/lib/api/errors";

// ─── apiError ───────────────────────────────────────────────────────────────

describe("apiError", () => {
  test("returns JSON response with correct status and message", async () => {
    const response = apiError("Not found", 404);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Not found");
    assert.ok(body.requestId, "should include a requestId");
  });

  test("uses provided requestId when given", async () => {
    const response = apiError("Bad request", 400, "custom-req-123");
    const body = await response.json();
    assert.equal(body.requestId, "custom-req-123");
  });

  test("auto-generates requestId when not provided", async () => {
    const r1 = apiError("err", 500);
    const r2 = apiError("err", 500);
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert.ok(b1.requestId);
    assert.ok(b2.requestId);
    // Auto-generated IDs should be unique
    assert.notEqual(b1.requestId, b2.requestId);
  });

  test("returns correct status codes", async () => {
    assert.equal(apiError("Unauthorized", 401).status, 401);
    assert.equal(apiError("Forbidden", 403).status, 403);
    assert.equal(apiError("Server error", 500).status, 500);
  });

  test("returns JSON content type", () => {
    const response = apiError("err", 400);
    assert.ok(
      response.headers.get("content-type")?.includes("application/json"),
    );
  });
});

// ─── withRequestId ──────────────────────────────────────────────────────────

describe("withRequestId", () => {
  test("attaches x-request-id header to response", () => {
    const response = new NextResponse(JSON.stringify({ ok: true }), {
      status: 200,
    });
    const result = withRequestId(response);
    const id = result.headers.get("x-request-id");
    assert.ok(id, "should have x-request-id header");
    assert.ok(id.length > 0);
  });

  test("generates unique IDs across calls", () => {
    const r1 = withRequestId(new NextResponse(null, { status: 200 }));
    const r2 = withRequestId(new NextResponse(null, { status: 200 }));
    assert.notEqual(
      r1.headers.get("x-request-id"),
      r2.headers.get("x-request-id"),
    );
  });
});

describe("withApiErrorBoundary", () => {
  test("preserves successful responses", async () => {
    const expected = NextResponse.json({ ok: true }, { status: 201 });
    assert.equal(
      await withApiErrorBoundary("test-route", async () => expected),
      expected,
    );
  });

  test("logs only a safe error classification and returns bounded JSON", async () => {
    const secret = "noo_this-must-not-leak";
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      const response = await withApiErrorBoundary("test-route", async () => {
        const hostile = new Error(secret);
        Object.defineProperty(hostile, "name", {
          get() {
            throw new Error(`${secret}-name-getter`);
          },
        });
        throw hostile;
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.deepEqual(body, { error: "Internal server error" });
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(calls), new RegExp(secret));
      assert.match(JSON.stringify(calls), /test-route/);
      assert.match(JSON.stringify(calls), /object/);
    } finally {
      console.error = original;
    }
  });
});
