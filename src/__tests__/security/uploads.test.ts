import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveUploadedImage, readUploadedImage } from "@/lib/uploads";

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

/**
 * Read the stored SVG and return its content as a string.
 */
async function readStoredSvg(filename: string): Promise<string> {
  const parts = filename.split("/");
  const imageData = await readUploadedImage(parts);
  return new TextDecoder("utf-8").decode(imageData.bytes);
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

test("saveUploadedImage sanitizes SVG script elements via DOMPurify", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "script.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle cx="5" cy="5" r="4" /></svg>'),
    );

    const stored = await readStoredSvg(saved.filename);
    assert.equal(stored.includes("<script>"), false, "script tag must be removed");
    assert.match(stored, /<svg/i, "svg element must remain after sanitization");
  });
});

test("saveUploadedImage sanitizes SVG event handler attributes", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "onload.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle cx="5" cy="5" r="4" /></svg>'),
    );

    const stored = await readStoredSvg(saved.filename);
    assert.equal(stored.includes("onload"), false, "onload attribute must be removed");
    assert.match(stored, /<svg/i, "svg element must remain after sanitization");
  });
});

test("saveUploadedImage sanitizes javascript: href URIs in SVG", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "javascript-href.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>'),
    );

    const stored = await readStoredSvg(saved.filename);
    assert.equal(stored.includes("javascript:"), false, "javascript: URI must be removed");
    assert.match(stored, /<svg/i, "svg element must remain after sanitization");
  });
});

test("saveUploadedImage sanitizes foreignObject elements in SVG", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "foreign-object.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>'),
    );

    const stored = await readStoredSvg(saved.filename);
    assert.equal(stored.includes("foreignObject"), false, "foreignObject element must be removed");
    assert.match(stored, /<svg/i, "svg element must remain after sanitization");
  });
});

test("saveUploadedImage rejects SVG with CSS expression (IE XSS vector)", async () => {
  // CSS expression() is an IE-only XSS vector. DOMPurify does not strip it
  // from <style> content by default, so we reject SVGs containing it.
  await withTempUploadDir(async () => {
    await assert.rejects(
      () =>
        saveUploadedImage(
          "style-expr.svg",
          svgBytes(
            '<svg xmlns="http://www.w3.org/2000/svg"><style>*{width:expression(alert(1))}</style><circle cx="5" cy="5" r="4" /></svg>',
          ),
        ),
      /SVG contains disallowed content/,
    );
  });
});

test("saveUploadedImage sanitizes entity-encoded script tags", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "entity-script.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg">&lt;script&gt;alert(1)&lt;/script&gt;</svg>'),
    );

    const stored = await readStoredSvg(saved.filename);
    // DOMPurify decodes entities before sanitizing, so script is stripped
    assert.equal(stored.includes("<script>"), false, "entity-decoded script tag must be removed");
    assert.match(stored, /<svg/i, "svg element must remain after sanitization");
  });
});

test("saveUploadedImage sanitizes hex-encoded script tags", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "hex-script.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg">&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;</svg>'),
    );

    const stored = await readStoredSvg(saved.filename);
    // DOMPurify decodes hex entities before sanitizing, so script is stripped
    assert.equal(stored.includes("<script>"), false, "hex-decoded script tag must be removed");
    assert.match(stored, /<svg/i, "svg element must remain after sanitization");
  });
});

test("saveUploadedImage does not crash on invalid numeric entities", async () => {
  await withTempUploadDir(async () => {
    const saved = await saveUploadedImage(
      "invalid-entity.svg",
      svgBytes('<svg xmlns="http://www.w3.org/2000/svg"><text>&#999999999999999999999999999;</text></svg>'),
    );

    assert.match(saved.filename, /^invalid-entity-[a-f0-9-]+\.svg$/);
    const stored = await readStoredSvg(saved.filename);
    assert.match(stored, /<svg/i, "svg element must remain");
  });
});

test("saveUploadedImage preserves safe SVG elements after sanitization", async () => {
  await withTempUploadDir(async () => {
    const safe =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<defs><linearGradient id="g"><stop offset="0%" stop-color="red"/></linearGradient></defs>' +
      '<rect x="10" y="10" width="80" height="80" fill="url(#g)"/>' +
      '<circle cx="50" cy="50" r="30" fill="blue"/>' +
      '<text x="50" y="50" text-anchor="middle">Hello</text>' +
      "</svg>";
    const saved = await saveUploadedImage("safe.svg", svgBytes(safe));

    const stored = await readStoredSvg(saved.filename);
    assert.match(stored, /<svg/i, "svg element must be preserved");
    assert.match(stored, /<rect/i, "rect element must be preserved");
    assert.match(stored, /<circle/i, "circle element must be preserved");
    assert.match(stored, /<text/i, "text element must be preserved");
    assert.match(stored, /<defs/i, "defs element must be preserved");
  });
});
