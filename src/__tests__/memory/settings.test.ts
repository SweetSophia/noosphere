/**
 * RecallSettings — Unit Tests
 *
 * Run with: DATABASE_URL="postgresql://test:test@localhost:5432/test" npx tsx src/__tests__/memory/settings.test.ts
 */

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

import {
  DEFAULT_RECALL_SETTINGS,
  mergeRecallSettings,
  normalizeRecallSettings,
} from "@/lib/memory/settings";
import type { RecallSettings } from "@/lib/memory/settings";

// ─── Test helpers ────────────────────────────────────────────────────────────

let testCounter = 0;
let passCount = 0;
let failCount = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  testCounter++;
  const label = `[${testCounter}] ${name}`;
  const p = Promise.resolve()
    .then(() => fn())
    .then(() => {
      passCount++;
      console.log(`  ✓ ${label}`);
    })
    .catch((err: unknown) => {
      failCount++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${label}\n    ${message}`);
    });
  pending.push(p);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n⚙️  RecallSettings Tests\n");

  // ─── Defaults ──────────────────────────────────────────────────────────

  test("normalizeRecallSettings returns defaults for empty input", () => {
    const settings = normalizeRecallSettings();
    assertEqual(settings.autoRecallEnabled, true, "autoRecallEnabled");
    assertEqual(settings.maxInjectedMemories, 20, "maxInjectedMemories");
    assertEqual(settings.maxInjectedTokens, 2000, "maxInjectedTokens");
    assertEqual(settings.recallVerbosity, "standard", "recallVerbosity");
    assertEqual(settings.deduplicationStrategy, "best-score", "deduplicationStrategy");
    assertEqual(settings.enabledProviders.length, 0, "enabledProviders empty");
    assertEqual(settings.summaryFirst, true, "summaryFirst");
  });

  test("DEFAULT_RECALL_SETTINGS has expected values", () => {
    assertEqual(DEFAULT_RECALL_SETTINGS.autoRecallEnabled, true, "autoRecallEnabled");
    assertEqual(DEFAULT_RECALL_SETTINGS.maxInjectedMemories, 20, "maxInjectedMemories");
    assertEqual(DEFAULT_RECALL_SETTINGS.maxInjectedTokens, 2000, "maxInjectedTokens");
  });

  // ─── Valid overrides ──────────────────────────────────────────────────

  test("respects valid overrides", () => {
    const settings = normalizeRecallSettings({
      autoRecallEnabled: false,
      maxInjectedMemories: 10,
      maxInjectedTokens: 500,
      recallVerbosity: "minimal",
      deduplicationStrategy: "most-recent",
      summaryFirst: false,
    });
    assertEqual(settings.autoRecallEnabled, false, "autoRecallEnabled");
    assertEqual(settings.maxInjectedMemories, 10, "maxInjectedMemories");
    assertEqual(settings.maxInjectedTokens, 500, "maxInjectedTokens");
    assertEqual(settings.recallVerbosity, "minimal", "recallVerbosity");
    assertEqual(settings.deduplicationStrategy, "most-recent", "deduplicationStrategy");
    assertEqual(settings.summaryFirst, false, "summaryFirst");
  });

  test("accepts enabledProviders list", () => {
    const settings = normalizeRecallSettings({
      enabledProviders: ["noosphere", "hindsight"],
    });
    assertEqual(settings.enabledProviders.length, 2, "2 providers");
    assertEqual(settings.enabledProviders[0], "noosphere", "first provider");
  });

  test("accepts providerPriorityWeights", () => {
    const settings = normalizeRecallSettings({
      providerPriorityWeights: { noosphere: 2.0, hindsight: 0.5 },
    });
    assertEqual(settings.providerPriorityWeights.noosphere, 2.0, "noosphere weight");
    assertEqual(settings.providerPriorityWeights.hindsight, 0.5, "hindsight weight");
  });

  // ─── Invalid inputs fall back to defaults ─────────────────────────────

  test("invalid maxInjectedMemories falls back", () => {
    assertEqual(normalizeRecallSettings({ maxInjectedMemories: -5 }).maxInjectedMemories, 20, "negative");
    assertEqual(normalizeRecallSettings({ maxInjectedMemories: 0 }).maxInjectedMemories, 20, "zero");
    assertEqual(normalizeRecallSettings({ maxInjectedMemories: NaN }).maxInjectedMemories, 20, "NaN");
    assertEqual(normalizeRecallSettings({ maxInjectedMemories: Infinity }).maxInjectedMemories, 20, "Infinity");
    assertEqual(normalizeRecallSettings({ maxInjectedMemories: 3.7 }).maxInjectedMemories, 3, "float floors");
  });

  test("invalid maxInjectedTokens falls back", () => {
    assertEqual(normalizeRecallSettings({ maxInjectedTokens: -1 }).maxInjectedTokens, 2000, "negative");
    assertEqual(normalizeRecallSettings({ maxInjectedTokens: 0 }).maxInjectedTokens, 2000, "zero");
  });

  test("invalid verbosity falls back to standard", () => {
    assertEqual(
      normalizeRecallSettings({ recallVerbosity: "ultra" as RecallSettings["recallVerbosity"] }).recallVerbosity,
      "standard",
      "invalid verbosity",
    );
  });

  test("invalid strategy falls back to best-score", () => {
    assertEqual(
      normalizeRecallSettings({ deduplicationStrategy: "random" as RecallSettings["deduplicationStrategy"] }).deduplicationStrategy,
      "best-score",
      "invalid strategy",
    );
  });

  test("enabledProviders filters non-string values", () => {
    const settings = normalizeRecallSettings({
      enabledProviders: ["noosphere", 42 as unknown as string, null as unknown as string],
    });
    assertEqual(settings.enabledProviders.length, 1, "only strings kept");
    assertEqual(settings.enabledProviders[0], "noosphere", "kept noosphere");
  });

  test("providerPriorityWeights filters invalid values", () => {
    const settings = normalizeRecallSettings({
      providerPriorityWeights: {
        noosphere: 2.0,
        bad: -1,
        also_bad: NaN as number,
        not_number: "high" as unknown as number,
      },
    });
    assertEqual(Object.keys(settings.providerPriorityWeights).length, 1, "only valid weight kept");
    assertEqual(settings.providerPriorityWeights.noosphere, 2.0, "valid weight preserved");
  });

  test("non-boolean autoRecallEnabled falls back to true", () => {
    assertEqual(
      normalizeRecallSettings({ autoRecallEnabled: "yes" as unknown as boolean }).autoRecallEnabled,
      true,
      "non-boolean fallback",
    );
  });

  test("non-boolean summaryFirst falls back to true", () => {
    assertEqual(
      normalizeRecallSettings({ summaryFirst: 1 as unknown as boolean }).summaryFirst,
      true,
      "non-boolean fallback",
    );
  });

  test("array as providerPriorityWeights falls back to empty", () => {
    const settings = normalizeRecallSettings({
      providerPriorityWeights: [] as unknown as Record<string, number>,
    });
    assertEqual(Object.keys(settings.providerPriorityWeights).length, 0, "empty object");
  });

  // ─── mergeRecallSettings ──────────────────────────────────────────────

  test("mergeRecallSettings applies overrides on top of base", () => {
    const base = normalizeRecallSettings({
      autoRecallEnabled: false,
      maxInjectedMemories: 5,
    });
    const merged = mergeRecallSettings(base, { maxInjectedMemories: 10 });
    assertEqual(merged.autoRecallEnabled, false, "base value kept");
    assertEqual(merged.maxInjectedMemories, 10, "override applied");
  });

  test("mergeRecallSettings re-normalizes merged result", () => {
    const base = normalizeRecallSettings({ maxInjectedMemories: 10 });
    const merged = mergeRecallSettings(base, { maxInjectedMemories: -1 });
    assertEqual(merged.maxInjectedMemories, 20, "invalid override re-normalized to default");
  });

  test("mergeRecallSettings with empty overrides returns base copy", () => {
    const base = normalizeRecallSettings({ maxInjectedMemories: 15 });
    const merged = mergeRecallSettings(base, {});
    assertEqual(merged.maxInjectedMemories, 15, "base preserved");
  });

  // ─── All verbosity values accepted ────────────────────────────────────

  const verbosities = ["minimal", "standard", "detailed"] as const;
  for (const v of verbosities) {
    test(`verbosity "${v}" is accepted`, () => {
      const settings = normalizeRecallSettings({ recallVerbosity: v });
      assertEqual(settings.recallVerbosity, v, `verbosity set to ${v}`);
    });
  }

  const strategies = ["best-score", "provider-priority", "most-recent"] as const;
  for (const s of strategies) {
    test(`strategy "${s}" is accepted`, () => {
      const settings = normalizeRecallSettings({ deduplicationStrategy: s });
      assertEqual(settings.deduplicationStrategy, s, `strategy set to ${s}`);
    });
  }

  // ─── Wait for all async tests ──────────────────────────────────────────

  await Promise.all(pending);

  console.log(
    `\n  ${passCount} passed, ${failCount} failed, ${testCounter} total\n`,
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
