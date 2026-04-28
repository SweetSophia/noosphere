/**
 * Local-only scheduler baseline for memory maintenance jobs.
 *
 * This module intentionally has no Vercel, queue, database, or network
 * dependency. It provides a small in-process scheduler that can be embedded in
 * a local CLI process, exercised by tests, and observed through status
 * snapshots. Durable job implementations can be wired in later without
 * changing the scheduling contract.
 *
 * @module scheduler
 */

export type SchedulerJobStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "disabled";

export interface SchedulerRunContext {
  /** Stable ID of the job being run. */
  jobId: string;

  /** ISO-8601 timestamp captured at the start of this run. */
  startedAt: string;

  /** Scheduler-visible run count before this run is recorded as complete. */
  runCount: number;
}

export interface SchedulerJobDefinition {
  /** Stable unique job ID. */
  id: string;

  /** Human-readable name for status output. */
  name: string;

  /** Recurrence interval in milliseconds. */
  intervalMs: number;

  /** Whether this job is eligible to run. Defaults to true. */
  enabled?: boolean;

  /** Whether start() should trigger this job immediately. Defaults to false. */
  runOnStart?: boolean;

  /** Job implementation. */
  run: (context: SchedulerRunContext) => void | Promise<void>;
}

export interface SchedulerJobSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  status: SchedulerJobStatus;
  runCount: number;
  failCount: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface SchedulerStatusSnapshot {
  running: boolean;
  jobCount: number;
  generatedAt: string;
  jobs: SchedulerJobSnapshot[];
}

export interface LocalMemorySchedulerOptions {
  /** Clock hook for deterministic tests. */
  now?: () => Date;

  /** Timer hook for deterministic tests. */
  setInterval?: typeof globalThis.setInterval;

  /** Timer hook for deterministic tests. */
  clearInterval?: typeof globalThis.clearInterval;

  /** Optional error logger. */
  onError?: (jobId: string, error: Error) => void;
}

interface SchedulerJobState extends SchedulerJobDefinition {
  enabled: boolean;
  status: SchedulerJobStatus;
  runCount: number;
  failCount: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export class LocalMemoryScheduler {
  private readonly jobs = new Map<string, SchedulerJobState>();
  private readonly timers = new Map<string, ReturnType<typeof globalThis.setInterval>>();
  private readonly inFlight = new Map<string, Promise<SchedulerJobSnapshot>>();
  private running = false;

  private readonly now: () => Date;
  private readonly setTimer: typeof globalThis.setInterval;
  private readonly clearTimer: typeof globalThis.clearInterval;
  private readonly onError?: (jobId: string, error: Error) => void;

  constructor(
    jobs: SchedulerJobDefinition[] = [],
    options: LocalMemorySchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setInterval ?? globalThis.setInterval;
    this.clearTimer = options.clearInterval ?? globalThis.clearInterval;
    this.onError = options.onError;

    for (const job of jobs) {
      this.registerJob(job);
    }
  }

  registerJob(job: SchedulerJobDefinition): void {
    validateJobDefinition(job);

    if (this.jobs.has(job.id)) {
      throw new Error(`Scheduler job already registered: ${job.id}`);
    }

    const enabled = job.enabled ?? true;
    const now = this.now().toISOString();

    this.jobs.set(job.id, {
      ...job,
      enabled,
      status: enabled ? "idle" : "disabled",
      runCount: 0,
      failCount: 0,
      nextRunAt: enabled ? addMs(now, job.intervalMs) : undefined,
    });

    if (this.running && enabled) {
      this.startJobTimer(job.id);
      if (job.runOnStart) {
        void this.runJob(job.id);
      }
    }
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;

    for (const job of this.jobs.values()) {
      if (!job.enabled) {
        continue;
      }

      this.startJobTimer(job.id);

      if (job.runOnStart) {
        void this.runJob(job.id);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    for (const timer of this.timers.values()) {
      this.clearTimer(timer);
    }
    this.timers.clear();
    this.running = false;

    await Promise.allSettled(this.inFlight.values());
  }

  async runJob(jobId: string): Promise<SchedulerJobSnapshot> {
    const job = this.getJob(jobId);

    if (!job.enabled) {
      job.status = "disabled";
      return snapshotJob(job);
    }

    if (job.status === "running") {
      return snapshotJob(job);
    }

    const run = this.executeJob(job);
    this.inFlight.set(job.id, run);

    try {
      return await run;
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async executeJob(job: SchedulerJobState): Promise<SchedulerJobSnapshot> {

    const startedAt = this.now().toISOString();
    job.status = "running";
    job.lastStartedAt = startedAt;
    job.lastError = undefined;

    try {
      await job.run({
        jobId: job.id,
        startedAt,
        runCount: job.runCount,
      });

      const completedAt = this.now().toISOString();
      job.status = "succeeded";
      job.runCount += 1;
      job.lastCompletedAt = completedAt;
      job.nextRunAt = addMs(completedAt, job.intervalMs);
    } catch (err) {
      const completedAt = this.now().toISOString();
      const error = err instanceof Error ? err : new Error(String(err));
      job.status = "failed";
      job.runCount += 1;
      job.failCount += 1;
      job.lastCompletedAt = completedAt;
      job.lastError = error.message;
      job.nextRunAt = addMs(completedAt, job.intervalMs);
      this.onError?.(job.id, error);
    }

    return snapshotJob(job);
  }

  async runDueJobs(now: Date = this.now()): Promise<SchedulerJobSnapshot[]> {
    const due: Promise<SchedulerJobSnapshot>[] = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled || job.status === "running" || !job.nextRunAt) {
        continue;
      }

      if (Date.parse(job.nextRunAt) <= now.getTime()) {
        due.push(this.runJob(job.id));
      }
    }

    return Promise.all(due);
  }

  getStatus(): SchedulerStatusSnapshot {
    return {
      running: this.running,
      jobCount: this.jobs.size,
      generatedAt: this.now().toISOString(),
      jobs: Array.from(this.jobs.values()).map(snapshotJob),
    };
  }

  private getJob(jobId: string): SchedulerJobState {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown scheduler job: ${jobId}`);
    }
    return job;
  }

  private startJobTimer(jobId: string): void {
    if (this.timers.has(jobId)) {
      return;
    }

    const job = this.getJob(jobId);
    const timer = this.setTimer(() => {
      void this.runJob(jobId);
    }, job.intervalMs);
    this.timers.set(jobId, timer);
  }
}

export function createLocalMemoryScheduler(
  jobs: SchedulerJobDefinition[] = [],
  options: LocalMemorySchedulerOptions = {},
): LocalMemoryScheduler {
  return new LocalMemoryScheduler(jobs, options);
}

export function createSchedulerHealthJob(
  intervalMs = 60_000,
): SchedulerJobDefinition {
  return {
    id: "memory.scheduler.health",
    name: "Memory scheduler health check",
    intervalMs,
    runOnStart: true,
    run: () => undefined,
  };
}

function validateJobDefinition(job: SchedulerJobDefinition): void {
  if (!job.id.trim()) {
    throw new Error("Scheduler job id is required");
  }

  if (!job.name.trim()) {
    throw new Error(`Scheduler job ${job.id} name is required`);
  }

  if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
    throw new Error(`Scheduler job ${job.id} intervalMs must be > 0`);
  }
}

function snapshotJob(job: SchedulerJobState): SchedulerJobSnapshot {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    intervalMs: job.intervalMs,
    status: job.status,
    runCount: job.runCount,
    failCount: job.failCount,
    lastStartedAt: job.lastStartedAt,
    lastCompletedAt: job.lastCompletedAt,
    lastError: job.lastError,
    nextRunAt: job.nextRunAt,
  };
}

function addMs(isoTimestamp: string, ms: number): string {
  return new Date(Date.parse(isoTimestamp) + ms).toISOString();
}
