import path from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import crypto from "crypto";
import DOMPurify from "isomorphic-dompurify";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

export function getUploadRoot() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
}

export function getImageDir() {
  return path.join(getUploadRoot(), "images");
}

export function sanitizeFilename(filename: string) {
  return filename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function getExtension(filename: string) {
  return path.extname(filename).toLowerCase();
}

export function getMimeType(filename: string) {
  return MIME_TYPES[getExtension(filename)] || "application/octet-stream";
}

export function assertAllowedImage(filename: string) {
  const ext = getExtension(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("Unsupported image type.");
  }
}

export function detectMimeType(bytes: Uint8Array): string | null {
  if (bytes.length < 2) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
  }

  // JPEG: FF D8
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }

  // GIF: 47 49 46 38 39 61 or 47 49 46 38 37 61
  if (bytes.length >= 6) {
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x39 || bytes[4] === 0x37) &&
      bytes[5] === 0x61
    ) {
      return "image/gif";
    }
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  // RIFF header at 0, WEBP at 8
  if (bytes.length >= 12) {
    if (
      bytes[0] === 0x52 && // R
      bytes[1] === 0x49 && // I
      bytes[2] === 0x46 && // F
      bytes[3] === 0x46 && // F
      bytes[8] === 0x57 && // W
      bytes[9] === 0x45 && // E
      bytes[10] === 0x42 && // B
      bytes[11] === 0x50 // P
    ) {
      return "image/webp";
    }
  }

  // SVG: scan UTF-8-decoded first 100 bytes for <svg element (handles XML decl, doctype, whitespace)
  const preamble = bytes.slice(0, Math.min(100, bytes.length));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(preamble);
  if (/<svg\b/i.test(text)) {
    return "image/svg+xml";
  }

  return null;
}

export async function saveUploadedImage(filename: string, bytes: Uint8Array) {
  assertAllowedImage(filename);

  const ext = getExtension(filename);
  const detectedMime = detectMimeType(bytes);

  if (detectedMime === null) {
    throw new Error("Image type mismatch or unrecognized format");
  }

  const expectedMime = MIME_TYPES[ext];
  if (detectedMime !== expectedMime) {
    throw new Error("Image type mismatch or unrecognized format");
  }

  // SVG sanitization: use DOMPurify to strip dangerous content before writing
  if (ext === ".svg") {
    const rawContent = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const sanitized = sanitizeSvg(rawContent);
    // Re-encode sanitized content back to bytes for storage
    bytes = new TextEncoder().encode(sanitized);
  }

  const base = sanitizeFilename(path.basename(filename, ext));
  const unique = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const finalName = `${base || "image"}-${unique}${ext}`;
  const dir = getImageDir();
  const absolutePath = path.join(dir, finalName);

  await mkdir(dir, { recursive: true });
  await writeFile(absolutePath, bytes);

  return {
    filename: finalName,
    absolutePath,
    publicUrl: `/uploads/images/${finalName}`,
  };
}

export function resolvePublicImagePath(parts: string[]) {
  // Validate each part - throw on any invalid segment
  for (const part of parts) {
    if (!part) {
      throw new Error("Invalid path: empty segment");
    }
    if (part === "." || part === "..") {
      throw new Error("Invalid path: dot segments not allowed");
    }
    if (part.includes("/") || part.includes("\\")) {
      throw new Error("Invalid path: slashes not allowed");
    }
    if (!/^[a-zA-Z0-9_\-.]+$/.test(part)) {
      throw new Error("Invalid path: unsupported characters");
    }
  }

  const resolved = path.join(getImageDir(), ...parts);

  // Security: Ensure resolved path is within upload directory
  // Use path.resolve to handle relative UPLOAD_DIR values correctly
  const resolvedPath = path.resolve(resolved);
  const imageDir = path.resolve(getImageDir());
  const relative = path.relative(imageDir, resolvedPath);
  if (relative.startsWith("..") || relative === "..") {
    throw new Error("Invalid path: outside upload directory");
  }

  return resolvedPath;
}

export async function readUploadedImage(parts: string[]) {
  const absolutePath = resolvePublicImagePath(parts);
  const bytes = await readFile(absolutePath);
  return {
    bytes,
    absolutePath,
    mimeType: getMimeType(absolutePath),
  };
}

// ─── SVG Sanitization ──────────────────────────────────────────────────────

/**
 * SVG elements we are willing to accept after sanitization.
 * We deliberately exclude <style> to reduce CSS attack surface.
 */
const SVG_ALLOWED_TAGS = [
  // Structural
  "svg", "g", "defs", "use", "symbol", "desc", "title", "metadata",
  // Shapes
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  // Text
  "text", "tspan", "textPath",
  // Gradients & effects
  "linearGradient", "radialGradient", "stop", "pattern",
  "clipPath", "mask", "filter", "marker",
  // Images (href is sanitized by DOMPurify)
  "image",
  // Presentation containers only (no <style>)
  "a", "switch",
] as string[];

/** Attributes we allow on the above elements. */
const SVG_ALLOWED_ATTRS = [
  // Core
  "id", "class", "xmlns", "viewBox", "preserveAspectRatio",
  // Geometry
  "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry",
  "x1", "y1", "x2", "y2", "points", "d",
  // Text
  "font-family", "font-size", "font-weight", "text-anchor", "dx", "dy",
  // Gradients
  "offset", "stop-color", "stop-opacity", "gradientTransform", "gradientUnits",
  // Links (DOMPurify will sanitize the URI values)
  "href", "xlink:href", "xlink:title",
  // Presentation / styling
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
  "opacity", "visibility", "display", "clip-path", "clipRule",
  "mask", "filter", "transform", "transform-origin", "pointer-events",
  "cursor", "marker-start", "marker-end", "marker-mid",
] as string[];

/** Attributes that are always dangerous in SVG context. */
const SVG_FORBIDDEN_ATTRS = [
  // All event handlers
  "onload", "onerror", "onclick", "onmouseover", "onmouseout",
  "onfocus", "onblur", "onchange", "onsubmit", "onkeydown",
  "onkeyup", "onkeypress", "ondblclick", "oncontextmenu",
  "ondrag", "ondragend", "ondragenter", "ondragleave", "ondragover",
  "ondrop", "onscroll", "onwheel", "oncopy", "oncut", "onpaste",
] as string[];

/** Elements we explicitly never want, even if DOMPurify would allow them. */
const SVG_FORBIDDEN_TAGS = ["script", "iframe", "foreignObject", "math"] as string[];

/**
 * Sanitize raw SVG markup using DOMPurify with a strict allowlist.
 *
 * We use an explicit allowlist rather than a profile because we want
 * fine-grained, auditable control over what is permitted.
 */
function sanitizeSvg(rawSvg: string): string {
  const clean = DOMPurify.sanitize(rawSvg, {
    FORBID_TAGS: SVG_FORBIDDEN_TAGS,
    ALLOWED_TAGS: SVG_ALLOWED_TAGS,
    ALLOWED_ATTR: SVG_ALLOWED_ATTRS,
    FORBID_ATTR: SVG_FORBIDDEN_ATTRS,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: [],
  });

  // Defense-in-depth: reject anything that no longer looks like an SVG
  // after sanitization. This catches both malicious input and bugs in
  // our allowlist configuration.
  if (!/<svg\b/i.test(clean)) {
    throw new Error("SVG contains disallowed content");
  }

  // CSS `expression()` is a legacy IE XSS vector that DOMPurify does not
  // strip by default (even though we forbid <style>). We reject the whole
  // upload if any <style> block contains an expression(). We intentionally
  // do NOT match expression() in text content (e.g. <text>gene expression (x)</text>)
  // to avoid false positives on legitimate SVG text.
  if (/<style[^>]*>[\s\S]*?expression\s*\([\s\S]*?<\/style>/i.test(clean)) {
    throw new Error("SVG contains disallowed content");
  }

  return clean;
}
