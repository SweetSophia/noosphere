import path from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import crypto from "crypto";

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

  // SVG XSS prevention: reject files with dangerous SVG features
  if (ext === ".svg") {
    const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Block <script tags, javascript: URIs, event handlers (on*=), and foreignObject
    if (/<script|on\w+\s*=|javascript:|foreignObject/i.test(content)) {
      throw new Error("Image type mismatch or unrecognized format");
    }
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
