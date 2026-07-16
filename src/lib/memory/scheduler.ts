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

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export interface LocalMemorySchedulerOptions {
  /** Clock hook for deterministic tests. */
  now?: () => Date;

  /** Timer hook for deterministic tests. */
  setTimeout?: typeof globalThis.setTimeout;

  /** Timer hook for deterministic tests. */
  clearTimeout?: typeof globalThis.clearTimeout;

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
  private readonly timers = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  private readonly inFlight = new Map<string, Promise<SchedulerJobSnapshot>>();
  private readonly _jobLocks = new Map<string, Deferred<SchedulerJobSnapshot>>();
  private running = false;

  private readonly now: () => Date;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private readonly onError?: (jobId: string, error: Error) => void;

  constructor(
    jobs: SchedulerJobDefinition[] = [],
    options: LocalMemorySchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
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

    // Try to acquire lock and execute; if already locked, wait for the running job
    const run = this.tryRunJobLocked(job);
    if (run) {
      return run;
    }

    // Lock not acquired — job is already running from another call
    const deferred = this._jobLocks.get(jobId);
    if (deferred) {
      return deferred.promise;
    }

    // Should never reach here: if lock not acquired, _jobLocks must have an entry
    throw new Error(`Scheduler internal error: no lock held for job ${jobId}`);
  }

  private async executeJob(
    job: SchedulerJobState,
  ): Promise<SchedulerJobSnapshot> {
    const startedAt = this.now().toISOString();
    job.status = "running";
    job.lastStartedAt = startedAt;
    job.lastError = undefined;
    job.nextRunAt = undefined;

    try {
      await job.run({
        jobId: job.id,
        startedAt,
        runCount: job.runCount,
      });
      job.status = "succeeded";
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      job.status = "failed";
      job.failCount += 1;
      job.lastError = error.message;
      this.onError?.(job.id, error);
    } finally {
      const completedAt = this.now().toISOString();
      job.runCount += 1;
      job.lastCompletedAt = completedAt;
      job.nextRunAt = addMs(completedAt, job.intervalMs);
      if (this.running && job.enabled) {
        this.startJobTimer(job.id);
      }
    }

    return snapshotJob(job);
  }

  async runDueJobs(now: Date = this.now()): Promise<SchedulerJobSnapshot[]> {
    // Acquire locks BEFORE executing — prevents duplicate concurrent execution
    // that was possible with the previous collect-then-lock pattern where
    // multiple concurrent runDueJobs calls could both collect the same job.
    // This is the fix for https://github.com/SweetSophia/noosphere/issues/138
    //
    // Uses the shared tryRunJobLocked() helper which ensures:
    // - Lock is acquired before execution
    // - inFlight is cleaned up via finally()
    // - Lock is released on both success and failure (defensive)
    const results: Promise<SchedulerJobSnapshot>[] = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled) {
        continue;
      }

      if (Date.parse(job.nextRunAt ?? "0") <= now.getTime()) {
        const run = this.tryRunJobLocked(job);
        if (run) {
          results.push(run);
        }
        // If lock not acquired, job is already running from another call.
        // The running job's snapshot will be returned to that caller only.
        // This is intentional: each runDueJobs call returns only the jobs
        // it personally started, not jobs already started by other calls.
      }
    }

    return Promise.all(results);
  }

  getStatus(): SchedulerStatusSnapshot {
    return {
      running: this.running,
      jobCount: this.jobs.size,
      generatedAt: this.now().toISOString(),
      jobs: Array.from(this.jobs.values()).map(snapshotJob),
    };
  }

  /**
   * Attempts to acquire lock and execute a job.
   * Returns the job promise if lock acquired, null if job is already locked.
   *
   * Lock is always released when the job completes (success or failure).
   * inFlight is always cleaned up when the job completes.
   *
   * This helper unifies the lock-execute-cleanup pattern used by both
   * runJob() and runDueJobs(), ensuring they stay in sync.
   */
  private tryRunJobLocked(
    job: SchedulerJobState,
  ): Promise<SchedulerJobSnapshot> | null {
    if (!this.tryAcquireJobLock(job.id)) {
      return null;
    }

    this.clearJobTimer(job.id);
    const run = this.executeJob(job);
    this.inFlight.set(job.id, run);

    // Clean up inFlight when job settles (success or failure)
    // Defensive: .catch() suppresses any unexpected rejection from finally()
    run.finally(() => {
      this.inFlight.delete(job.id);
    }).catch(() => {});

    // Release lock when job completes.
    // Defensive: .catch() ensures lock is released even if job fails,
    // by resolving with a snapshot of the failed job state.
    run
      .then((result) => this.releaseJobLock(job.id, result))
      .catch(() => this.releaseJobLock(job.id, snapshotJob(job)));

    return run;
  }

  private getJob(jobId: string): SchedulerJobState {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown scheduler job: ${jobId}`);
    }
    return job;
  }

  private tryAcquireJobLock(jobId: string): boolean {
    if (this._jobLocks.has(jobId)) {
      return false;
    }
    const deferred = new Deferred<SchedulerJobSnapshot>();
    this._jobLocks.set(jobId, deferred);
    return true;
  }

  private releaseJobLock(jobId: string, result: SchedulerJobSnapshot): void {
    const deferred = this._jobLocks.get(jobId);
    if (deferred) {
      this._jobLocks.delete(jobId);
      deferred.resolve(result);
    }
  }

  private startJobTimer(jobId: string): void {
    if (this.timers.has(jobId)) {
      return;
    }

    const job = this.getJob(jobId);
    if (!job.enabled || !job.nextRunAt) {
      return;
    }

    const dueAt = Date.parse(job.nextRunAt);
    const delayMs = Math.max(0, dueAt - this.now().getTime());
    const timer = this.setTimer(() => {
      this.timers.delete(jobId);
      const currentJob = this.getJob(jobId);
      if (!currentJob.enabled || currentJob.status === "running") {
        return;
      }

      void this.runJob(jobId);
    }, delayMs);
    this.timers.set(jobId, timer);
  }

  private clearJobTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (!timer) {
      return;
    }

    this.clearTimer(timer);
    this.timers.delete(jobId);
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
    // Baseline health signal: prove the scheduler event loop can execute a job.
    // Real provider/database checks are intentionally deferred to durable jobs.
    run: () => undefined,
  };
}

export function parseSchedulerIntervalMs(
  value: string | undefined,
  fallback: number,
  minimum = 1,
): number {
  if (value === undefined) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function validateJobDefinition(job: SchedulerJobDefinition): void {
  if (typeof job.id !== "string" || !job.id.trim()) {
    throw new Error("Scheduler job id is required");
  }

  if (typeof job.name !== "string" || !job.name.trim()) {
    throw new Error(`Scheduler job ${String(job.id)} name is required`);
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
