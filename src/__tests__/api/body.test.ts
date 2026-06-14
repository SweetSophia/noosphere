import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  safeJsonParse,
  getJsonBodyError,
  JsonDepthExceededError,
  RequestBodyTooLargeError,
  readBoundedJsonBody,
  readBoundedJson,
  readBoundedJsonObject,
} from "@/lib/api/body";
import { NextRequest } from "next/server";

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeRequest(body: string, contentType = "application/json"): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

// ─── safeJsonParse ──────────────────────────────────────────────────────────

describe("safeJsonParse", () => {
  test("parses valid JSON objects", () => {
    const result = safeJsonParse('{"key":"value"}');
    assert.deepEqual(result, { key: "value" });
  });

  test("parses arrays", () => {
    const result = safeJsonParse("[1,2,3]");
    assert.deepEqual(result, [1, 2, 3]);
  });

  test("parses primitives", () => {
    assert.equal(safeJsonParse('"hello"'), "hello");
    assert.equal(safeJsonParse("42"), 42);
    assert.equal(safeJsonParse("true"), true);
    assert.equal(safeJsonParse("null"), null);
  });

  test("throws SyntaxError on malformed JSON", () => {
    assert.throws(() => safeJsonParse("{invalid}"), SyntaxError);
  });

  test("throws JsonDepthExceededError on deeply nested objects", () => {
    // Build a deeply nested structure: {"a":{"a":{"a":...}}}
    const depth = 25;
    let json = "1";
    for (let i = 0; i < depth; i++) json = `{"a":${json}}`;
    assert.throws(() => safeJsonParse(json), JsonDepthExceededError);
  });

  test("allows moderately nested objects within limit", () => {
    // Depth of 5 should be fine (limit is 20)
    const depth = 5;
    let json = "1";
    for (let i = 0; i < depth; i++) json = `{"a":${json}}`;
    assert.doesNotThrow(() => safeJsonParse(json));
  });

  test("allows flat objects with more fields than the nesting limit", () => {
    const flatObject = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field${index}`, index]),
    );

    assert.deepEqual(safeJsonParse(JSON.stringify(flatObject)), flatObject);
  });

  test("ignores structural characters inside JSON strings", () => {
    const value = { content: "[[[{{{ deeply-looking but still a string }}}]]]" };

    assert.deepEqual(safeJsonParse(JSON.stringify(value)), value);
  });

  test("does not let unmatched closing delimiters offset later nesting", () => {
    const nested = `${'{"value":'.repeat(21)}0${"}".repeat(21)}`;

    assert.throws(
      () => safeJsonParse(`}${nested}`),
      JsonDepthExceededError,
    );
  });

  test("parses nested arrays", () => {
    const result = safeJsonParse('{"items":[{"name":"a"},{"name":"b"}]}');
    assert.deepEqual(result, { items: [{ name: "a" }, { name: "b" }] });
  });
});

// ─── Error classes ──────────────────────────────────────────────────────────

describe("Error classes", () => {
  test("RequestBodyTooLargeError has correct name and message", () => {
    const err = new RequestBodyTooLargeError();
    assert.equal(err.name, "RequestBodyTooLargeError");
    assert.equal(err.message, "Request body is too large");
    assert.ok(err instanceof Error);
  });

  test("JsonDepthExceededError has correct name and message", () => {
    const err = new JsonDepthExceededError();
    assert.equal(err.name, "JsonDepthExceededError");
    assert.equal(err.message, "JSON nesting depth exceeds limit");
    assert.ok(err instanceof Error);
  });

  test("getJsonBodyError maps body limits to 413", () => {
    assert.deepEqual(getJsonBodyError(new RequestBodyTooLargeError()), {
      message: "Request body is too large",
      status: 413,
    });
    assert.deepEqual(getJsonBodyError(new JsonDepthExceededError()), {
      message: "JSON nesting depth exceeds limit",
      status: 413,
    });
  });

  test("getJsonBodyError maps malformed JSON to 400", () => {
    assert.deepEqual(getJsonBodyError(new SyntaxError("Unexpected token")), {
      message: "Invalid JSON body",
      status: 400,
    });
  });
});

// ─── readBoundedJsonBody ────────────────────────────────────────────────────

describe("readBoundedJsonBody", () => {
  test("reads body within size limit", async () => {
    const body = '{"hello":"world"}';
    const req = makeRequest(body);
    const result = await readBoundedJsonBody(req);
    assert.equal(result, body);
  });

  test("throws RequestBodyTooLargeError when body exceeds maxBytes", async () => {
    const body = "x".repeat(100);
    const req = makeRequest(body);
    await assert.rejects(
      () => readBoundedJsonBody(req, 50),
      RequestBodyTooLargeError,
    );
  });

  test("rejects an oversized Content-Length before reading the stream", async () => {
    const req = makeRequest("{}", "application/json");
    req.headers.set("content-length", "100");

    await assert.rejects(
      () => readBoundedJsonBody(req, 50),
      RequestBodyTooLargeError,
    );
  });

  test("returns empty string when request has no body", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      method: "GET",
    });
    const result = await readBoundedJsonBody(req);
    assert.equal(result, "");
  });

  test("reads exactly at the size limit", async () => {
    const body = "a".repeat(64);
    const req = makeRequest(body);
    const result = await readBoundedJsonBody(req, 64);
    assert.equal(result, body);
  });
});

// ─── readBoundedJson ────────────────────────────────────────────────────────

describe("readBoundedJson", () => {
  test("reads and parses JSON body", async () => {
    const req = makeRequest('{"key":"value"}');
    const result = await readBoundedJson(req);
    assert.deepEqual(result, { key: "value" });
  });

  test("throws on oversized body", async () => {
    const req = makeRequest("x".repeat(100));
    await assert.rejects(
      () => readBoundedJson(req, 50),
      RequestBodyTooLargeError,
    );
  });

  test("throws SyntaxError on invalid JSON within size limit", async () => {
    const req = makeRequest("{not-json}");
    await assert.rejects(() => readBoundedJson(req), SyntaxError);
  });
});

describe("readBoundedJsonObject", () => {
  test("reads JSON objects", async () => {
    const result = await readBoundedJsonObject(makeRequest('{"key":"value"}'));
    assert.deepEqual(result, { key: "value" });
  });

  test("rejects null, arrays, and primitive JSON values", async () => {
    for (const body of ["null", "[]", '"text"', "42"]) {
      await assert.rejects(
        () => readBoundedJsonObject(makeRequest(body)),
        SyntaxError,
      );
    }
  });
});
