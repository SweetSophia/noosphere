import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const JSON_BODY_ROUTES = [
  "src/app/api/tags/route.ts",
  "src/app/api/tags/[id]/route.ts",
  "src/app/api/answer/route.ts",
  "src/app/api/scopes/route.ts",
  "src/app/api/keys/route.ts",
  "src/app/api/ingest/route.ts",
  "src/app/api/keys/[id]/route.ts",
  "src/app/api/lint/route.ts",
  "src/app/api/memory/settings/route.ts",
  "src/app/api/sync/obsidian/route.ts",
  "src/app/api/topics/route.ts",
  "src/app/api/articles/route.ts",
  "src/app/api/topics/[id]/route.ts",
  "src/app/api/articles/[id]/route.ts",
] as const;

for (const routePath of JSON_BODY_ROUTES) {
  test(`${routePath} uses the bounded JSON parser`, async () => {
    const source = await readFile(path.join(process.cwd(), routePath), "utf8");

    assert.doesNotMatch(source, /request\.json\s*\(/);
    assert.match(source, /readBoundedJson(?:Object)?(?:<[^>]+>)?\s*\(/);
  });
}
