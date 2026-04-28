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
    const scheduler = createLocalMemoryScheduler(
      [makeJob({ id: "job.health", intervalMs: 1_000 })],
      {
        now: fixedClock("2026-04-28T00:00:00.000Z"),
      },
    );

    const status = scheduler.getStatus();
    assert.equal(status.running, false);
    assert.equal(status.jobCount, 1);
    assert.equal(status.jobs[0].id, "job.health");
    assert.equal(status.jobs[0].status, "idle");
    assert.equal(status.jobs[0].nextRunAt, "2026-04-28T00:00:01.000Z");
  });

  test("[2] runJob records success metrics", async () => {
    let calls = 0;
    const scheduler = createLocalMemoryScheduler(
      [
        makeJob({
          run: ({ jobId, runCount }) => {
            calls += 1;
            assert.equal(jobId, "job.test");
            assert.equal(runCount, 0);
          },
        }),
      ],
      {
        now: fixedClock("2026-04-28T00:00:00.000Z"),
      },
    );

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
    const scheduler = createLocalMemoryScheduler(
      [
        makeJob({
          run: () => {
            throw new Error("boom");
          },
        }),
      ],
      {
        onError: (jobId, error) => errors.push(`${jobId}:${error.message}`),
      },
    );

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
    const scheduler = createLocalMemoryScheduler(
      [
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
      ],
      {
        now: fixedClock("2026-04-28T00:00:00.000Z"),
      },
    );

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
    const scheduler = new LocalMemoryScheduler(
      [makeJob({ intervalMs: 5_000 })],
      {
        setTimeout: ((..._args: Parameters<typeof globalThis.setTimeout>) => {
          void _args;
          const id = timerIds.length + 1;
          timerIds.push(id);
          return id as unknown as ReturnType<typeof globalThis.setTimeout>;
        }) as typeof globalThis.setTimeout,
        clearTimeout: ((timer) => {
          cleared.push(timer as unknown as number);
        }) as typeof globalThis.clearTimeout,
      },
    );

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
    const callbacks: (() => void)[] = [];
    let calls = 0;
    let now = new Date("2026-04-28T00:00:00.000Z");
    const scheduler = new LocalMemoryScheduler(
      [
        makeJob({
          runOnStart: true,
          run: () => {
            calls += 1;
          },
        }),
      ],
      {
        now: () => now,
        setTimeout: ((
          cb: Parameters<typeof globalThis.setTimeout>[0],
          ..._args: unknown[]
        ) => {
          void _args;
          callbacks.push(cb as () => void);
          return callbacks.length as unknown as ReturnType<
            typeof globalThis.setTimeout
          >;
        }) as typeof globalThis.setTimeout,
        clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
      },
    );

    scheduler.start();
    await flushMicrotasks();
    assert.equal(calls, 1);

    now = new Date("2026-04-28T00:00:01.000Z");
    callbacks.shift()?.();
    await flushMicrotasks();
    assert.equal(calls, 2);
    await scheduler.stop();
  });

  test("[10] stop waits for in-flight job completion", async () => {
    let resolveRun: (() => void) | undefined;
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        run: () =>
          new Promise<void>((resolve) => {
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
    assert.throws(
      () => createLocalMemoryScheduler([makeJob({ id: "" })]),
      /id is required/,
    );
    assert.throws(
      () =>
        createLocalMemoryScheduler([makeJob({ id: 123 as unknown as string })]),
      /id is required/,
    );
    assert.throws(
      () => createLocalMemoryScheduler([makeJob({ name: "" })]),
      /name is required/,
    );
    assert.throws(
      () =>
        createLocalMemoryScheduler([
          makeJob({ name: 123 as unknown as string }),
        ]),
      /name is required/,
    );
    assert.throws(
      () => createLocalMemoryScheduler([makeJob({ intervalMs: 0 })]),
      /intervalMs must be > 0/,
    );
  });

  test("[12] concurrent runJob callers await the same in-flight run", async () => {
    let calls = 0;
    let resolveRun: (() => void) | undefined;
    const scheduler = createLocalMemoryScheduler([
      makeJob({
        run: () => {
          calls += 1;
          return new Promise<void>((resolve) => {
            resolveRun = resolve;
          });
        },
      }),
    ]);

    const first = scheduler.runJob("job.test");
    await flushMicrotasks();
    const second = scheduler.runJob("job.test");
    await flushMicrotasks();

    assert.equal(calls, 1);
    resolveRun?.();

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.equal(firstSnapshot.status, "succeeded");
    assert.deepEqual(secondSnapshot, firstSnapshot);
    assert.equal(scheduler.getStatus().jobs[0].runCount, 1);
  });

  test("[13] timeout schedules exactly at nextRunAt after completion", async () => {
    const scheduledDelays: number[] = [];
    const callbacks: (() => void)[] = [];
    let calls = 0;
    let now = new Date("2026-04-28T00:00:00.000Z");
    const scheduler = new LocalMemoryScheduler(
      [
        makeJob({
          intervalMs: 1_000,
          run: () => {
            calls += 1;
          },
        }),
      ],
      {
        now: () => now,
        setTimeout: ((cb: () => void, ms?: number) => {
          callbacks.push(cb);
          scheduledDelays.push(ms ?? 0);
          return callbacks.length as unknown as ReturnType<
            typeof globalThis.setTimeout
          >;
        }) as typeof globalThis.setTimeout,
        clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
      },
    );

    scheduler.start();
    assert.deepEqual(scheduledDelays, [1_000]);

    now = new Date("2026-04-28T00:00:01.000Z");
    callbacks.shift()?.();
    await flushMicrotasks();
    assert.equal(calls, 1);
    assert.deepEqual(scheduledDelays, [1_000, 1_000]);

    now = new Date("2026-04-28T00:00:02.100Z");
    callbacks.shift()?.();
    await flushMicrotasks();
    assert.equal(calls, 2);
    assert.deepEqual(scheduledDelays, [1_000, 1_000, 1_000]);
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
