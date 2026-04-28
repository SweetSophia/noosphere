/**
 * Local memory scheduler entrypoint.
 *
 * Usage:
 *   npm run memory:scheduler -- --once
 *   npm run memory:scheduler
 *
 * Environment:
 *   MEMORY_SCHEDULER_HEALTH_INTERVAL_MS=60000
 */

import {
  createLocalMemoryScheduler,
  createSchedulerHealthJob,
} from "../src/lib/memory/scheduler";

void main();

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const status = args.has("--status");

  const healthIntervalMs = parsePositiveInt(
    process.env.MEMORY_SCHEDULER_HEALTH_INTERVAL_MS,
    60_000,
  );

  const scheduler = createLocalMemoryScheduler([
    createSchedulerHealthJob(healthIntervalMs),
  ]);

  if (status) {
    printStatus(scheduler);
    return;
  }

  if (once) {
    await scheduler.runJob("memory.scheduler.health");
    printStatus(scheduler);
    return;
  }

  scheduler.start();
  printStatus(scheduler);

  process.on("SIGINT", () => {
    void stop(scheduler);
  });
  process.on("SIGTERM", () => {
    void stop(scheduler);
  });
}

async function stop(
  scheduler: ReturnType<typeof createLocalMemoryScheduler>,
): Promise<void> {
  await scheduler.stop();
  printStatus(scheduler);
  process.exit(0);
}

function printStatus(
  scheduler: ReturnType<typeof createLocalMemoryScheduler>,
): void {
  console.log(JSON.stringify(scheduler.getStatus(), null, 2));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
