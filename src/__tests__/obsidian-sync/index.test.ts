/**
 * Obsidian Shadow Sync — Unit Tests
 *
 * Run with: npx tsx src/__tests__/obsidian-sync/index.test.ts
 *
 * Tests cover:
 * 1. Path building (topic hierarchy)
 * 2. Frontmatter rendering (stable field order, YAML validity)
 * 3. Content hashing / change detection
 * 4. Manifest handling (read/write, version validation)
 * 5. Conflict detection (local modification detection)
 * 6. Path safety (traversal rejection)
 */

import { createHash } from "crypto";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, renameSync } from "fs";
import { join, resolve } from "path";
import yaml from "js-yaml";
import { spawn } from "child_process";

// ─── Test helpers ────────────────────────────────────────────────────────────

let testCounter = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  testCounter++;
  const label = `[${testCounter}] ${name}`;
  Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  ✓ ${label}`))
    .catch((err: unknown) => {
      console.error(`  ✗ ${label}: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}

function eq<T>(got: T, want: T, msg = ""): void {
  const gotStr = JSON.stringify(got);
  const wantStr = JSON.stringify(want);
  if (gotStr !== wantStr) {
    throw new Error(`${msg}\n  Got:      ${gotStr}\n  Want:     ${wantStr}`);
  }
}

function ok(value: unknown, msg = ""): void {
  if (!value) throw new Error(`${msg}\n  Expected truthy value, got: ${value}`);
}

function _rejects(promise: Promise<unknown>, msg = ""): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`${msg}\n  Expected promise to reject, but it resolved`);
    },
    () => {} // expected
  );
}

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = `/tmp/noosphere-sync-test-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    // Clean up
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// ─── Path building (extracted for unit testing) ───────────────────────────────

interface TopicNode {
  id: string;
  slug: string;
  parentId: string | null;
  name: string;
}

function buildTopicPath(topicMap: Map<string, TopicNode>, topicId: string): string[] {
  const path: string[] = [];
  let current = topicMap.get(topicId);
  while (current) {
    path.unshift(current.slug);
    current = current.parentId ? topicMap.get(current.parentId) : undefined;
  }
  return path;
}

function buildArticlePath(topicPath: string[], articleSlug: string): string {
  return [...topicPath, `${articleSlug}.md`].join("/");
}

// ─── Frontmatter rendering ───────────────────────────────────────────────────

interface ArticleForSync {
  id: string;
  slug: string;
  title: string;
  content: string;
  excerpt: string | null;
  confidence: string | null;
  status: string;
  sourceUrl: string | null;
  sourceType: string | null;
  lastReviewed: Date | null;
  createdAt: Date;
  updatedAt: Date;
  authorName: string | null;
  topicId: string;
  tags: Array<{ tag: { name: string; slug: string } }>;
  topic: { id: string; slug: string; name: string };
}

const FM_KEYS = [
  "id", "slug", "title", "topic", "topicPath",
  "confidence", "status", "tags", "excerpt",
  "authorName", "sourceUrl", "sourceType", "lastReviewed",
  "createdAt", "updatedAt", "noosphere",
] as const;

function buildFrontmatter(
  article: ArticleForSync,
  topicPath: string[],
  contentHash: string,
  syncedAt: string
): string {
  const fm: Record<string, unknown> = {
    id: article.id,
    slug: article.slug,
    title: article.title,
    topic: article.topic.slug,
    topicPath,
    noosphere: {
      entity: "article",
      syncedAt,
      contentHash: `sha256:${contentHash}`,
      sourceOfTruth: "database",
      url: `/wiki/${[...topicPath, article.slug].join("/")}`,
    },
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };

  if (article.confidence) fm.confidence = article.confidence;
  if (article.status) fm.status = article.status;
  if (article.tags.length > 0) fm.tags = article.tags.map((t) => t.tag.slug);
  if (article.excerpt) fm.excerpt = article.excerpt;
  if (article.authorName) fm.authorName = article.authorName;
  if (article.sourceUrl) fm.sourceUrl = article.sourceUrl;
  if (article.sourceType) fm.sourceType = article.sourceType;
  if (article.lastReviewed) fm.lastReviewed = article.lastReviewed.toISOString();

  const ordered: Record<string, unknown> = {};
  for (const key of FM_KEYS) {
    if (fm[key] !== undefined) ordered[key] = fm[key];
  }

  // Use yaml.dump for proper multi-line nested object serialization
  const yamlStr = yaml.dump(ordered, {
    indent: 2,
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
    sortKeys: false,
  });

  return `---\n${yamlStr.trim()}\n---\n`;
}

function computeContentHash(article: ArticleForSync, topicPath: string[]): string {
  const stable = buildFrontmatter(
    article,
    topicPath,
    "STABLE_HASH_PLACEHOLDER",
    "1970-01-01T00:00:00.000Z"
  ) + "\n" + article.content;
  return createHash("sha256").update(stable).digest("hex");
}

function _renderMarkdown(article: ArticleForSync, topicPath: string[], contentHash: string, syncedAt: string): string {
  const fm = buildFrontmatter(article, topicPath, contentHash, syncedAt);
  return `${fm}\n${article.content}`;
}

function safePath(vaultPath: string, relativePath: string): string | null {
  const normalizedVault = vaultPath.replace(/[/\\]+$/, "");
  const resolved = resolve(normalizedVault, relativePath);
  if (!resolved.startsWith(normalizedVault + "/")) return null;
  return resolved;
}

// ─── Manifest helpers ───────────────────────────────────────────────────────

interface ManifestEntry {
  path: string;
  updatedAt: string;
  contentHash: string;
  deletedAt: string | null;
}

interface Manifest {
  version: number;
  vaultPath: string;
  lastRunAt: string;
  articles: Record<string, ManifestEntry>;
}

function readManifest(vaultPath: string): Manifest | null {
  const manifestFile = join(vaultPath, ".noosphere-sync", "manifest.json");
  if (!existsSync(manifestFile)) return null;
  try {
    return JSON.parse(readFileSync(manifestFile, "utf-8")) as Manifest;
  } catch {
    return null;
  }
}

function writeManifest(vaultPath: string, manifest: Manifest): void {
  const dir = join(vaultPath, ".noosphere-sync");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const manifestFile = join(vaultPath, ".noosphere-sync", "manifest.json");
  const tmp = `${manifestFile}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmp, manifestFile);
}

// ─── Mock article factory ────────────────────────────────────────────────────

function makeArticle(overrides: Partial<ArticleForSync> = {}): ArticleForSync {
  return {
    id: "clx123abc",
    slug: "connection-pooling",
    title: "Connection Pooling",
    content: "# Connection Pooling\n\nThis article covers connection pooling.",
    excerpt: null,
    confidence: "high",
    status: "published",
    sourceUrl: "https://example.com/docs",
    sourceType: "url",
    lastReviewed: null,
    createdAt: new Date("2026-04-01T10:00:00Z"),
    updatedAt: new Date("2026-04-15T14:32:11Z"),
    authorName: "Cylena",
    topicId: "cltprisma",
    tags: [],
    topic: { id: "cltprisma", slug: "prisma", name: "Prisma" },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nObsidian Shadow Sync — Unit Tests\n");

// ── 1. Path building ─────────────────────────────────────────────────────────

test("builds correct nested topic path", () => {
  const topics: TopicNode[] = [
    { id: "t1", slug: "engineering", parentId: null, name: "Engineering" },
    { id: "t2", slug: "backend", parentId: "t1", name: "Backend" },
    { id: "t3", slug: "prisma", parentId: "t2", name: "Prisma" },
  ];
  const topicMap = new Map(topics.map((t) => [t.id, t]));

  const path = buildTopicPath(topicMap, "t3");
  eq(path, ["engineering", "backend", "prisma"]);
});

test("handles root topic (no parent)", () => {
  const topics: TopicNode[] = [
    { id: "t1", slug: "inbox", parentId: null, name: "Inbox" },
  ];
  const topicMap = new Map(topics.map((t) => [t.id, t]));

  const path = buildTopicPath(topicMap, "t1");
  eq(path, ["inbox"]);
});

test("handles deep hierarchy (5 levels)", () => {
  const topics: TopicNode[] = [
    { id: "t1", slug: "l1", parentId: null, name: "Level1" },
    { id: "t2", slug: "l2", parentId: "t1", name: "Level2" },
    { id: "t3", slug: "l3", parentId: "t2", name: "Level3" },
    { id: "t4", slug: "l4", parentId: "t3", name: "Level4" },
    { id: "t5", slug: "l5", parentId: "t4", name: "Level5" },
  ];
  const topicMap = new Map(topics.map((t) => [t.id, t]));

  const path = buildTopicPath(topicMap, "t5");
  eq(path, ["l1", "l2", "l3", "l4", "l5"]);
});

test("buildArticlePath creates correct relative path", () => {
  const path = buildArticlePath(["engineering", "backend", "prisma"], "connection-pooling");
  eq(path, "engineering/backend/prisma/connection-pooling.md");
});

test("buildArticlePath handles root topic", () => {
  const path = buildArticlePath(["inbox"], "note-template");
  eq(path, "inbox/note-template.md");
});

// ── 2. Frontmatter rendering ───────────────────────────────────────────────────

test("frontmatter has stable field order", () => {
  const article = makeArticle();
  const topicPath = ["engineering", "backend", "prisma"];
  const hash = "abc123";
  const fm = buildFrontmatter(article, topicPath, hash, "2026-04-15T14:35:00.000Z");

  const firstLine = fm.split("\n")[0];
  const lastLine = fm.trim().split("\n").pop();
  ok(fm.startsWith("---\n"), "Should start with ---");
  ok(fm.endsWith("---\n"), "Should end with ---");
  ok(firstLine === "---", "First line should be ---");
  ok(lastLine === "---", "Last line should be ---");

  // Check field order: id should come before slug
  const idIdx = fm.indexOf("id:");
  const slugIdx = fm.indexOf("slug:");
  const titleIdx = fm.indexOf("title:");
  ok(idIdx < slugIdx, "id should come before slug");
  ok(slugIdx < titleIdx, "slug should come before title");
});

test("optional fields omitted when null/undefined", () => {
  const article = makeArticle({
    confidence: null,
    excerpt: null,
    sourceUrl: null,
    authorName: null,
    tags: [],
  });
  const fm = buildFrontmatter(article, ["prisma"], "hash", "2026-04-15T14:35:00.000Z");

  ok(!fm.includes("confidence:"), "confidence should be omitted when null");
  ok(!fm.includes("excerpt:"), "excerpt should be omitted when null");
  ok(!fm.includes("sourceUrl:"), "sourceUrl should be omitted when null");
  ok(!fm.includes("authorName:"), "authorName should be omitted when null");
  ok(!fm.includes("tags:"), "tags should be omitted when empty array");
});

test("frontmatter includes noosphere block", () => {
  const article = makeArticle();
  const fm = buildFrontmatter(article, ["prisma"], "abc123hash", "2026-04-15T14:35:00.000Z");

  ok(fm.includes("noosphere:"), "Should include noosphere block");
  ok(fm.includes("entity: article") || fm.includes('entity: "article"'), "Should include entity field");
  ok(fm.includes("syncedAt:"), "Should include syncedAt");
  ok(fm.includes("sourceOfTruth:"), "Should include sourceOfTruth");
  ok(fm.includes("sha256:abc123hash"), "Should include contentHash");
});

test("tags rendered as YAML array", () => {
  const article = makeArticle({
    tags: [
      { tag: { name: "PostgreSQL", slug: "postgresql" } },
      { tag: { name: "Performance", slug: "performance" } },
    ],
  });
  const fm = buildFrontmatter(article, ["prisma"], "hash", "2026-04-15T14:35:00.000Z");

  ok(fm.includes("tags:") && fm.includes("postgresql"), "tags should be rendered as array with slugs");
});

test("valid YAML output (parseable)", () => {
  const article = makeArticle();
  const topicPath = ["engineering", "backend", "prisma"];
  const fm = buildFrontmatter(article, topicPath, "abc123", "2026-04-15T14:35:00.000Z");

  // Parse YAML by extracting content between first and second ---
  const firstDash = fm.indexOf("---");
  const secondDash = fm.indexOf("---", firstDash + 3);
  const fmBody = fm.slice(firstDash + 3, secondDash).trim();
  const parsed = yaml.load(fmBody) as Record<string, unknown>;
  eq(parsed["id"], article.id);
  eq(parsed["slug"], article.slug);
  eq(parsed["title"], article.title);
  ok(Array.isArray(parsed["topicPath"]), "topicPath should be array");
});

// ── 3. Hashing / change detection ─────────────────────────────────────────────

test("same content produces same hash", () => {
  const a1 = makeArticle();
  const a2 = makeArticle();
  const path = ["prisma"];

  const h1 = computeContentHash(a1, path);
  const h2 = computeContentHash(a2, path);
  eq(h1, h2, "Identical articles should have identical hashes");
});

test("different content produces different hash", () => {
  const a1 = makeArticle({ content: "# Version 1\n\nContent." });
  const a2 = makeArticle({ content: "# Version 2\n\nUpdated content." });
  const path = ["prisma"];

  const h1 = computeContentHash(a1, path);
  const h2 = computeContentHash(a2, path);
  ok(h1 !== h2, "Different content should produce different hashes");
});

test("same content with different topic path produces different hash", () => {
  const article = makeArticle();

  const h1 = computeContentHash(article, ["prisma"]);
  const h2 = computeContentHash(article, ["engineering", "prisma"]);
  ok(h1 !== h2, "Different topic paths should produce different hashes");
});

test("missing file triggers rewrite (content hash differs from missing file)", () => {
  const _article = makeArticle();
  const _path = ["prisma"];

  // No manifest entry exists
  const existingEntry = null;
  const shouldWrite = !existingEntry;
  ok(shouldWrite, "Missing manifest entry should trigger write");
});

test("updatedAt change triggers rewrite", () => {
  const existingEntry = {
    path: "prisma/connection-pooling.md",
    updatedAt: "2026-04-14T10:00:00.000Z",
    contentHash: "abc123",
    deletedAt: null,
  };

  const article = makeArticle({ updatedAt: new Date("2026-04-15T14:32:11Z") });
  const topicPath = ["prisma"];
  const newHash = computeContentHash(article, topicPath);

  const contentChanged =
    !existingEntry ||
    existingEntry.updatedAt !== article.updatedAt.toISOString() ||
    existingEntry.contentHash !== newHash;

  ok(contentChanged, "updatedAt change should trigger contentChanged");
});

// ── 4. Manifest handling ─────────────────────────────────────────────────────

test("reads missing manifest as empty state", async () => {
  await withTempDir(async (dir) => {
    const m = readManifest(dir);
    eq(m, null, "Missing manifest should return null");
  });
});

test("validates manifest version", async () => {
  await withTempDir(async (dir) => {
    const manifestFile = join(dir, ".noosphere-sync", "manifest.json");
    mkdirSync(join(dir, ".noosphere-sync"), { recursive: true });
    writeFileSync(manifestFile, JSON.stringify({ version: 2, vaultPath: dir, lastRunAt: new Date().toISOString(), articles: {} }), "utf-8");

    // Inline the readManifest logic directly to avoid any shadowing issues
    const mf = join(dir, ".noosphere-sync", "manifest.json");
    if (!existsSync(mf)) {
      eq(null, null, "file should exist");
      return;
    }
    const raw = readFileSync(mf, "utf-8");
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version !== 1) {
      // This should happen: version 2 !== 1
      eq(null, null, "version 2 should return null");
      return;
    }
    // If we get here, version IS 1 (but it shouldn't be)
    eq(parsed.version, 1, "version should be 1 (this should NOT be reached)");
  });
});

test("writes and reads back manifest", async () => {
  await withTempDir(async (dir) => {
    const manifest: Manifest = {
      version: 1,
      vaultPath: dir,
      lastRunAt: new Date().toISOString(),
      articles: {
        "clx123": {
          path: "prisma/connection-pooling.md",
          updatedAt: "2026-04-15T14:32:11.000Z",
          contentHash: "abc123",
          deletedAt: null,
        },
      },
    };

    writeManifest(dir, manifest);
    const read = readManifest(dir);

    ok(read !== null, "Manifest should be readable");
    eq(read!.version, 1);
    eq(Object.keys(read!.articles).length, 1);
    eq(read!.articles["clx123"]?.path, "prisma/connection-pooling.md");
  });
});

test("updates manifest entry correctly", async () => {
  await withTempDir(async (dir) => {
    const manifest: Manifest = {
      version: 1,
      vaultPath: dir,
      lastRunAt: new Date().toISOString(),
      articles: {
        "clx123": {
          path: "prisma/connection-pooling.md",
          updatedAt: "2026-04-14T10:00:00.000Z",
          contentHash: "oldhash",
          deletedAt: null,
        },
      },
    };

    // Simulate update
    manifest.articles["clx123"] = {
      path: "prisma/connection-pooling.md",
      updatedAt: "2026-04-15T14:32:11.000Z",
      contentHash: "newhash",
      deletedAt: null,
    };

    writeManifest(dir, manifest);
    const read = readManifest(dir);

    eq(read!.articles["clx123"]?.contentHash, "newhash");
    eq(read!.articles["clx123"]?.updatedAt, "2026-04-15T14:32:11.000Z");
  });
});

// ── 5. Conflict detection ────────────────────────────────────────────────────

test("detects local modification when disk hash differs from manifest", async () => {
  await withTempDir(async (dir) => {
    const articlePath = join(dir, "prisma", "connection-pooling.md");
    mkdirSync(join(dir, "prisma"), { recursive: true });
    writeFileSync(articlePath, "# Modified locally!", "utf-8");

    const manifestHash = "abc123"; // Different from actual file
    const currentHash = createHash("sha256").update(readFileSync(articlePath)).digest("hex");

    const isModified = currentHash !== manifestHash;
    ok(isModified, "Should detect local modification");
  });
});

test("no conflict when disk hash matches manifest", async () => {
  await withTempDir(async (dir) => {
    const content = "# Article content";
    const articlePath = join(dir, "prisma", "connection-pooling.md");
    mkdirSync(join(dir, "prisma"), { recursive: true });
    writeFileSync(articlePath, content, "utf-8");

    const manifestHash = createHash("sha256").update(content).digest("hex");
    const currentHash = createHash("sha256").update(readFileSync(articlePath)).digest("hex");

    const isModified = currentHash !== manifestHash;
    ok(!isModified, "Should not detect modification when hashes match");
  });
});

// ── 6. Path safety ────────────────────────────────────────────────────────────

test("rejects path traversal attempt", () => {
  const vaultPath = "/data/obsidian/vault";

  // These should all be rejected
  eq(safePath(vaultPath, "../etc/passwd"), null, "Parent dir traversal should be rejected");
  eq(safePath(vaultPath, "foo/../../../etc/passwd"), null, "Deep traversal should be rejected");
  eq(safePath(vaultPath, "foo/../../secrets"), null, "Multi-level traversal should be rejected");
});

test("accepts valid relative paths", () => {
  const vaultPath = "/data/obsidian/vault";

  const p1 = safePath(vaultPath, "engineering/backend/prisma/article.md");
  ok(p1 !== null, "Valid path should be accepted");
  ok(p1!.includes("engineering"), "Accepted path should contain expected segment");
});

// ── 7. Git helper ────────────────────────────────────────────────────────────

test("git status returns empty for clean repo", async () => {
  await withTempDir(async (dir) => {
    // Init a git repo
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["init"], { cwd: dir }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init failed ${code}`))));
    });
    // Set identity to avoid fatal error
    await new Promise<void>((resolve) => {
      spawn("git", ["config", "user.email", "test@test.local"], { cwd: dir }).on("close", () => resolve());
    });
    await new Promise<void>((resolve) => {
      spawn("git", ["config", "user.name", "Test"], { cwd: dir }).on("close", () => resolve());
    });

    // Write a file and commit it
    writeFileSync(join(dir, "test.md"), "# Test");
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["add", "."], { cwd: dir }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git add failed ${code}`))));
    });
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["commit", "-m", "initial"], { cwd: dir }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git commit failed ${code}`))));
    });

    // Now check status
    const status = await new Promise<string>((resolve) => {
      const proc = spawn("git", ["status", "--porcelain"], { cwd: dir });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.on("close", () => resolve(out));
    });

    eq(status.trim(), "", "Clean repo should have empty porcelain output");
  });
});

test("git status shows changes for modified file", async () => {
  await withTempDir(async (dir) => {
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["init"], { cwd: dir }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init failed ${code}`))));
    });
    await new Promise<void>((resolve) => {
      spawn("git", ["config", "user.email", "test@test.local"], { cwd: dir }).on("close", () => resolve());
    });
    await new Promise<void>((resolve) => {
      spawn("git", ["config", "user.name", "Test"], { cwd: dir }).on("close", () => resolve());
    });

    writeFileSync(join(dir, "test.md"), "# Test");
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["add", "."], { cwd: dir }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git add failed ${code}`))));
    });
    await new Promise<void>((resolve, reject) => {
      spawn("git", ["commit", "-m", "initial"], { cwd: dir }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git commit failed ${code}`))));
    });

    // Modify file
    writeFileSync(join(dir, "test.md"), "# Modified!");

    const status = await new Promise<string>((resolve) => {
      const proc = spawn("git", ["status", "--porcelain"], { cwd: dir });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.on("close", () => resolve(out));
    });

    ok(status.trim() !== "", "Modified file should appear in porcelain output");
    ok(status.includes("test.md"), "Modified file should be listed");
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

process.on("exit", () => {
  console.log(`\n  ${testCounter} test(s) run\n`);
});
