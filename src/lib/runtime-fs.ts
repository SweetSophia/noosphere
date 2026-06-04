import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { readFile } from "fs/promises";
import type { Dirent, Stats } from "fs";
import { join, resolve } from "path";

/**
 * Helpers for operator-configured runtime paths.
 *
 * Next/Turbopack output tracing is build-time analysis. Keeping vault file and
 * path operations behind these wrappers prevents callers from exposing a local
 * Obsidian vault path directly in route modules that Turbopack traces.
 *
 * The `turbopackIgnore` comments are visual markers for runtime-only path
 * arguments. The wrapper boundary is the important part: it keeps operator
 * configured vault paths out of direct build-time tracing paths.
 */

export function runtimeJoin(root: string, ...segments: string[]): string {
  return join(/*turbopackIgnore: true*/ root, ...segments);
}

export function runtimeResolve(root: string, ...segments: string[]): string {
  return resolve(/*turbopackIgnore: true*/ root, ...segments);
}

export function runtimeExists(path: string): boolean {
  return existsSync(/*turbopackIgnore: true*/ path);
}

export function runtimeMkdir(path: string): void {
  mkdirSync(/*turbopackIgnore: true*/ path, { recursive: true });
}

export function runtimeReadFile(path: string): Buffer;
export function runtimeReadFile(path: string, encoding: BufferEncoding): string;
export function runtimeReadFile(path: string, encoding?: BufferEncoding): Buffer | string {
  return encoding
    ? readFileSync(/*turbopackIgnore: true*/ path, encoding)
    : readFileSync(/*turbopackIgnore: true*/ path);
}

export function runtimeReadTextFileAsync(path: string): Promise<string> {
  return readFile(/*turbopackIgnore: true*/ path, "utf-8");
}

// Writes bytes or caller-supplied strings without forcing an encoding. Use
// runtimeWriteTextFile for UTF-8 text output.
export function runtimeWriteFile(path: string, content: string | Buffer): void {
  writeFileSync(/*turbopackIgnore: true*/ path, content);
}

export function runtimeWriteTextFile(path: string, content: string): void {
  writeFileSync(/*turbopackIgnore: true*/ path, content, "utf-8");
}

export function runtimeRename(from: string, to: string): void {
  renameSync(/*turbopackIgnore: true*/ from, /*turbopackIgnore: true*/ to);
}

export function runtimeUnlink(path: string): void {
  unlinkSync(/*turbopackIgnore: true*/ path);
}

export function runtimeReadDir(path: string): Dirent[] {
  return readdirSync(/*turbopackIgnore: true*/ path, { withFileTypes: true });
}

export function runtimeLstat(path: string): Stats {
  return lstatSync(/*turbopackIgnore: true*/ path);
}

export function runtimeRealpath(path: string): string {
  return realpathSync(/*turbopackIgnore: true*/ path);
}
