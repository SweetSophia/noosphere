import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WRITE_PATHS = [
  {
    path: "src/app/wiki/[topicSlug]/new/actions.ts",
    writes: ["tx.article.create"],
  },
  {
    path: "src/app/wiki/[topicSlug]/[articleSlug]/edit/actions.ts",
    writes: ["tx.article.update", "tx.articleRevision.create"],
  },
  {
    path: "src/lib/markdown-sync/import-applier.ts",
    writes: ["prisma.article.update", "prisma.article.create"],
  },
] as const;

test("non-API article write paths sanitize content before persistence", async () => {
  for (const writePath of WRITE_PATHS) {
    const source = await readFile(writePath.path, "utf8");
    const sanitizeIndex = source.indexOf("sanitizeArticleContent");
    const secretScanIndex = source.indexOf("detectSecretInInputs");
    const observationIndex = source.indexOf("buildArticleStripObservation");

    assert.notEqual(sanitizeIndex, -1, `${writePath.path} must strip article content`);
    assert.notEqual(secretScanIndex, -1, `${writePath.path} must scan sanitized inputs for secrets`);
    assert.notEqual(observationIndex, -1, `${writePath.path} must build strip observability details`);

    for (const writeNeedle of writePath.writes) {
      const writeIndex = source.indexOf(writeNeedle);
      assert.notEqual(writeIndex, -1, `${writePath.path} must still contain ${writeNeedle}`);
      assert.ok(
        sanitizeIndex < writeIndex,
        `${writePath.path} must sanitize content before ${writeNeedle}`,
      );
      assert.ok(
        secretScanIndex < writeIndex,
        `${writePath.path} must scan secrets before ${writeNeedle}`,
      );
    }
  }
});
