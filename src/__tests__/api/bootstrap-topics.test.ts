import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface BootstrapTopic {
  name: string;
  slug: string;
  description?: string | null;
  children?: BootstrapTopic[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readBootstrapTopics() {
  return JSON.parse(
    readFileSync(resolve(repoRoot, "docker", "bootstrap-topics.json"), "utf8"),
  ) as BootstrapTopic[];
}

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("bootstrap topic tree is valid and shared by seed/bootstrap scripts", () => {
  const topics = readBootstrapTopics();
  const slugs = new Set<string>();

  function visit(topic: BootstrapTopic) {
    assert.equal(typeof topic.name, "string");
    assert.equal(typeof topic.slug, "string");
    assert.match(topic.slug, /^[a-z0-9-]+$/);
    assert.equal(slugs.has(topic.slug), false, `duplicate topic slug: ${topic.slug}`);
    slugs.add(topic.slug);
    for (const child of topic.children ?? []) visit(child);
  }

  assert.ok(topics.length > 0, "bootstrap topics should not be empty");
  for (const topic of topics) visit(topic);
  assert.ok(slugs.has("noosphere"));
  assert.ok(slugs.has("pk-pro"));
  assert.ok(slugs.has("ihk-study-trainer"));
});

test("bootstrap and seed scripts load the shared topic tree file", () => {
  const bootstrapSource = readRepoFile("docker/bootstrap.mjs");
  const seedSource = readRepoFile("scripts/seed-topics.ts");

  assert.match(bootstrapSource, /bootstrap-topics\.json/);
  assert.match(seedSource, /bootstrap-topics\.json/);
  assert.doesNotMatch(bootstrapSource, /const\s+TOPICS\s*=\s*\[/);
  assert.doesNotMatch(seedSource, /const\s+TOPICS\s*=\s*\[/);
});
