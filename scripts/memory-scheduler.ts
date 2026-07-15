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
  parseSchedulerIntervalMs,
} from "../src/lib/memory/scheduler";
import { createDurableMemoryMaintenanceJob } from "../src/lib/memory/capture/maintenance";

main().catch((err) => {
  console.error("Fatal error in scheduler:", err);
  process.exit(1);
});

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const status = args.has("--status");

  const healthIntervalMs = parseSchedulerIntervalMs(
    process.env.MEMORY_SCHEDULER_HEALTH_INTERVAL_MS,
    60_000,
  );
  const maintenanceIntervalMs = parseSchedulerIntervalMs(
    process.env.MEMORY_DURABLE_MAINTENANCE_INTERVAL_MS,
    60_000,
    1_000,
  );

  const scheduler = createLocalMemoryScheduler([
    createSchedulerHealthJob(healthIntervalMs),
    createDurableMemoryMaintenanceJob(maintenanceIntervalMs),
  ]);

  if (status) {
    printStatus(scheduler);
    return;
  }

  if (once) {
    const snapshots = [];
    snapshots.push(await scheduler.runJob("memory.scheduler.health"));
    snapshots.push(await scheduler.runJob("memory.durable-maintenance"));
    printStatus(scheduler);
    if (snapshots.some(({ status: jobStatus }) => jobStatus === "failed")) {
      process.exitCode = 1;
    }
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
