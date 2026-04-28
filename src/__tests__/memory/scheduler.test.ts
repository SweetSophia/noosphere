/**
 * LocalMemoryScheduler — Unit Tests
 *
 * Run with: npx tsx src/__tests__/memory/scheduler.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createLocalMemoryScheduler,
  createSchedulerHealthJob,
  LocalMemoryScheduler,
  type SchedulerJobDefinition,
} from "@/lib/memory/scheduler";

describe("local memory scheduler", () => {
  test("[1] starts with observable idle job status", () => {
    const scheduler = createLocalMemoryScheduler([
      makeJob({ id: "job.health", intervalMs: 1_000 }),
    ], {
      now: fixedClock("2026-04-28T00:00:00.000Z"),
    });

    const status = scheduler.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.jobCount, 1);
    assert.equal(status.jobs[0].id, "job.health");
    assert.equal(status.jobs[0].status, "idle");
    assert.equal(status.jobs[0].nextRunAt, "2026-04-28T00:00:01.000Z");
  });

  test("[2] runJob records success metrics", async () => {
    let calls = 0;
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        run: ({ jobId, runCount }) => {
          calls += 1;
          assert.equal(jobId, "job.test");
          assert.equal(runCount, 0);
        },
      }),
    ], {
      now: fixedClock("2026-04-28T00:00:00.000Z"),
    });

    const snapshot = await scheduler.runJob("job.test");
    assert.equal(calls, 1);
    assert.equal(snapshot.status, "succeeded");
    assert.equal(snapshot.runCount, 1);
    assert.equal(snapshot.failCount, 0);
    assert.equal(snapshot.lastStartedAt, "2026-04-28T00:00:00.000Z");
    assert.equal(snapshot.lastCompletedAt, "2026-04-28T00:00:00.000Z");
  });

  test("[3] runJob records failures without throwing", async () => {
    const errors: string[] = [];
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        run: () => {
          throw new Error("boom");
        },
      }),
    ], {
      onError: (jobId, error) => errors.push(`${jobId}:${error.message}`),
    });

    const snapshot = await scheduler.runJob("job.test");
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.runCount, 1);
    assert.equal(snapshot.failCount, 1);
    assert.equal(snapshot.lastError, "boom");
    assert.deepEqual(errors, ["job.test:boom"]);
  });

  test("[4] disabled jobs do not run", async () => {
    let calls = 0;
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        enabled: false,
        run: () => {
          calls += 1;
        },
      }),
    ]);

    const snapshot = await scheduler.runJob("job.test");
    assert.equal(calls, 0);
    assert.equal(snapshot.status, "disabled");
    assert.equal(snapshot.runCount, 0);
  });

  test("[5] runDueJobs only runs due jobs", async () => {
    let dueCalls = 0;
    let futureCalls = 0;
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        id: "job.due",
        intervalMs: 1_000,
        run: () => {
          dueCalls += 1;
        },
      }),
      makeJob({
        id: "job.future",
        intervalMs: 60_000,
        run: () => {
          futureCalls += 1;
        },
      }),
    ], {
      now: fixedClock("2026-04-28T00:00:00.000Z"),
    });

    const snapshots = await scheduler.runDueJobs(
      new Date("2026-04-28T00:00:02.000Z"),
    );

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, "job.due");
    assert.equal(dueCalls, 1);
    assert.equal(futureCalls, 0);
  });

  test("[6] start and stop use local timers", async () => {
    const timerIds: number[] = [];
    const cleared: number[] = [];
    const scheduler = new LocalMemoryScheduler([
      makeJob({ intervalMs: 5_000 }),
    ], {
      setInterval: ((_callback: () => void, _ms?: number) => {
        const id = timerIds.length + 1;
        timerIds.push(id);
        return id as unknown as ReturnType<typeof globalThis.setInterval>;
      }) as typeof globalThis.setInterval,
      clearInterval: ((timer) => {
        cleared.push(timer as unknown as number);
      }) as typeof globalThis.clearInterval,
    });

    scheduler.start();
    assert.equal(scheduler.getStatus().running, true);
    assert.deepEqual(timerIds, [1]);

    await scheduler.stop();
    assert.equal(scheduler.getStatus().running, false);
    assert.deepEqual(cleared, [1]);
  });

  test("[7] registerJob rejects duplicate IDs", () => {
    const scheduler = createLocalMemoryScheduler([makeJob()]);
    assert.throws(() => scheduler.registerJob(makeJob()), /already registered/);
  });

  test("[8] createSchedulerHealthJob provides local observable no-op", async () => {
    const scheduler = createLocalMemoryScheduler([
      createSchedulerHealthJob(2_000),
    ]);

    const snapshot = await scheduler.runJob("memory.scheduler.health");
    assert.equal(snapshot.status, "succeeded");
    assert.equal(snapshot.intervalMs, 2_000);
  });

  test("[9] runOnStart triggers immediate execution on start", async () => {
    let callback: (() => void) | undefined;
    let calls = 0;
    const scheduler = new LocalMemoryScheduler([
      makeJob({
        runOnStart: true,
        run: () => {
          calls += 1;
        },
      }),
    ], {
      setInterval: ((cb: () => void, _ms?: number) => {
        callback = cb;
        return 1 as unknown as ReturnType<typeof globalThis.setInterval>;
      }) as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as typeof globalThis.clearInterval,
    });

    scheduler.start();
    await flushMicrotasks();
    assert.equal(calls, 1);

    callback?.();
    await flushMicrotasks();
    assert.equal(calls, 2);
    await scheduler.stop();
  });

  test("[10] stop waits for in-flight job completion", async () => {
    let resolveRun: (() => void) | undefined;
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        run: () => new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
      }),
    ]);

    scheduler.start();
    const run = scheduler.runJob("job.test");
    await flushMicrotasks();
    assert.equal(scheduler.getStatus().jobs[0].status, "running");

    const stopped = scheduler.stop();
    let stopCompleted = false;
    stopped.then(() => {
      stopCompleted = true;
    });
    await flushMicrotasks();
    assert.equal(stopCompleted, false);

    resolveRun?.();
    await run;
    await stopped;
    assert.equal(stopCompleted, true);
    assert.equal(scheduler.getStatus().jobs[0].status, "succeeded");
  });

  test("[11] registerJob validates required fields", () => {
    assert.throws(() => createLocalMemoryScheduler([makeJob({ id: "" })]), /id is required/);
    assert.throws(() => createLocalMemoryScheduler([makeJob({ name: "" })]), /name is required/);
    assert.throws(() => createLocalMemoryScheduler([makeJob({ intervalMs: 0 })]), /intervalMs must be > 0/);
  });
});

function makeJob(
  overrides: Partial<SchedulerJobDefinition> = {},
): SchedulerJobDefinition {
  return {
    id: "job.test",
    name: "Test job",
    intervalMs: 1_000,
    run: () => undefined,
    ...overrides,
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
