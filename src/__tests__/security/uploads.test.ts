import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveUploadedImage } from "@/lib/uploads";

const encoder = new TextEncoder();

function svgBytes(content: string) {
  return encoder.encode(content);
}

async function withTempUploadDir(fn: () => Promise<void>) {
  const previousUploadDir = process.env.UPLOAD_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), "noosphere-upload-test-"));
  process.env.UPLOAD_DIR = dir;

  try {
    await fn();
  } finally {
    if (previousUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = previousUploadDir;
    }
    await rm(dir, { force: true, recursive: true });
  }
}

async function assertSvgRejected(content: string) {
  await withTempUploadDir(async () => {
    await assert.rejects(
      () => saveUploadedImage("payload.svg", svgBytes(content)),
      /SVG contains disallowed content/,
    );
  });
}

test("saveUploadedImage accepts simple SVG uploads", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "diagram.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>'),
    );

    assert.match(saved.filename, /^diagram-[a-f0-9-]+\.svg$/);
    assert.equal(saved.publicUrl.startsWith("/uploads/images/diagram-"), true);
  });
});

test("saveUploadedImage rejects script-capable SVG constructs", async () => {
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>');
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>');
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg"><style>*{width:expression(alert(1))}</style></svg>');
});

test("saveUploadedImage rejects entity-encoded SVG script tags", async () => {
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg">&lt;script&gt;alert(1)&lt;/script&gt;</svg>');
  await assertSvgRejected('<svg xmlns="http://www.w3.org/2000/svg">&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;</svg>');
});

test("saveUploadedImage does not crash on invalid numeric entities", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "invalid-entity.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg"><text>&#999999999999999999999999999;</text></svg>'),
    );

    assert.match(saved.filename, /^invalid-entity-[a-f0-9-]+\.svg$/);
  });
});
