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

export async function saveUploadedImage(filename: string, bytes: Uint8Array) {
  assertAllowedImage(filename);

  const ext = getExtension(filename);
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
    if (!/^[a-zA-Z0-9_\-. ]+$/.test(part)) {
      throw new Error("Invalid path: unsupported characters");
    }
  }

  const resolved = path.join(getImageDir(), ...parts);

  // Security: Ensure resolved path is within upload directory
  const imageDir = getImageDir();
  if (!resolved.startsWith(imageDir + path.sep) && resolved !== imageDir) {
    throw new Error("Invalid path: outside upload directory");
  }

  return resolved;
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
