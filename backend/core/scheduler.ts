import type { MonitorType } from '../adapters/contracts/types.js';

export type MonitorJobState = 'queued' | 'running' | 'retry' | 'disabled';

export interface MonitorJob {
  id: string;
  siteId: string;
  monitorType: MonitorType;
  state: MonitorJobState;
  nextRunAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
  attempts: number;
  runRequested: boolean;
  lastErrorCode?: string;
}

export interface JobSchedule {
  intervalMs: number;
  jitterPercent: number;
  observationRetryLimit?: number;
  observationRetryIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface JobRunOutcome {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  /** True retries a transient observation with the configured fixed policy; false returns to the normal cadence. */
  retryable?: boolean;
}

function timeMilliseconds(value: Date | string | number): number {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('A valid timestamp is required');
  return milliseconds;
}

function isoTime(value: Date | string | number): string {
  return new Date(timeMilliseconds(value)).toISOString();
}

function withoutLease(job: MonitorJob): MonitorJob {
  const { leaseOwner: _leaseOwner, leaseUntil: _leaseUntil, ...rest } = job;
  return rest;
}

export function computeJitteredDelay(
  intervalMs: number,
  jitterPercent: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('intervalMs must be non-negative');
  if (!Number.isFinite(jitterPercent) || jitterPercent < 0 || jitterPercent > 100) {
    throw new Error('jitterPercent must be between 0 and 100');
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('random() must return a value between 0 and 1');
  }
  const spread = jitterPercent / 100;
  return Math.max(0, Math.round(intervalMs * (1 + (sample * 2 - 1) * spread)));
}

export function computeRetryDelay(
  attempts: number,
  options: {
    retryAfterMs?: number;
    baseMs?: number;
    maxMs?: number;
    jitterPercent?: number;
    random?: () => number;
  } = {},
): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer');
  if (options.retryAfterMs !== undefined) {
    if (!Number.isFinite(options.retryAfterMs) || options.retryAfterMs < 0) {
      throw new Error('retryAfterMs must be non-negative');
    }
    return Math.round(options.retryAfterMs);
  }
  const baseMs = options.baseMs ?? 60_000;
  const maxMs = options.maxMs ?? 3_600_000;
  if (baseMs <= 0 || maxMs <= 0 || maxMs < baseMs) {
    throw new Error('Retry bounds are invalid');
  }
  const exponent = Math.min(attempts - 1, 30);
  const delay = Math.min(maxMs, baseMs * 2 ** exponent);
  return computeJitteredDelay(delay, options.jitterPercent ?? 10, options.random);
}

export function isLeaseExpired(job: MonitorJob, now: Date | string | number): boolean {
  return (
    job.state === 'running' &&
    (job.leaseUntil === undefined || timeMilliseconds(job.leaseUntil) <= timeMilliseconds(now))
  );
}

export function isJobClaimable(job: MonitorJob, now: Date | string | number): boolean {
  if (job.state === 'disabled') return false;
  const nowMs = timeMilliseconds(now);
  if (job.state === 'running') return isLeaseExpired(job, nowMs);
  return timeMilliseconds(job.nextRunAt) <= nowMs;
}

export function claimMonitorJob(
  job: MonitorJob,
  leaseOwner: string,
  now: Date | string | number,
  leaseDurationMs: number,
): MonitorJob | undefined {
  if (!leaseOwner) throw new Error('leaseOwner is required');
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('leaseDurationMs must be positive');
  }
  const nowMs = timeMilliseconds(now);
  if (!isJobClaimable(job, nowMs)) return undefined;
  return {
    ...job,
    state: 'running',
    leaseOwner,
    leaseUntil: new Date(nowMs + leaseDurationMs).toISOString(),
  };
}

export function requestImmediateRun(
  job: MonitorJob,
  now: Date | string | number,
): MonitorJob {
  if (job.state === 'disabled') return { ...job };
  const at = isoTime(now);
  if (job.state === 'running' && !isLeaseExpired(job, at)) {
    return { ...job, runRequested: true };
  }
  return {
    ...withoutLease(job),
    state: 'queued',
    nextRunAt: at,
    attempts: 0,
    runRequested: false,
  };
}

export function finishMonitorJob(
  job: MonitorJob,
  leaseOwner: string,
  outcome: JobRunOutcome,
  now: Date | string | number,
  schedule: JobSchedule,
  random: () => number = Math.random,
): MonitorJob {
  if (job.state !== 'running' || job.leaseOwner !== leaseOwner) {
    throw new Error('Only the current lease owner can finish a running job');
  }
  const nowMs = timeMilliseconds(now);
  const released = withoutLease(job);
  if (job.runRequested) {
    const { lastErrorCode: _lastErrorCode, ...withoutError } = released;
    return {
      ...(outcome.success ? withoutError : released),
      state: 'queued',
      nextRunAt: new Date(nowMs).toISOString(),
      runRequested: false,
      attempts: 0,
      ...(outcome.errorCode ? { lastErrorCode: outcome.errorCode } : {}),
    };
  }
  if (outcome.success) {
    const { lastErrorCode: _lastErrorCode, ...withoutError } = released;
    return {
      ...withoutError,
      state: 'queued',
      nextRunAt: new Date(
        nowMs + computeJitteredDelay(schedule.intervalMs, schedule.jitterPercent, random),
      ).toISOString(),
      runRequested: false,
      attempts: 0,
    };
  }
  if (outcome.retryable === false) {
    return {
      ...released,
      state: 'queued',
      nextRunAt: new Date(
        nowMs + computeJitteredDelay(schedule.intervalMs, schedule.jitterPercent, random),
      ).toISOString(),
      runRequested: false,
      attempts: 0,
      ...(outcome.errorCode ? { lastErrorCode: outcome.errorCode } : {}),
    };
  }
  if (outcome.retryable === true) {
    const attempts = job.attempts + 1;
    const retryLimit = schedule.observationRetryLimit ?? 0;
    if (attempts > retryLimit) {
      return {
        ...released,
        state: 'queued',
        nextRunAt: new Date(
          nowMs + computeJitteredDelay(schedule.intervalMs, schedule.jitterPercent, random),
        ).toISOString(),
        runRequested: false,
        attempts: 0,
        ...(outcome.errorCode ? { lastErrorCode: outcome.errorCode } : {}),
      };
    }
    const configuredDelay = schedule.observationRetryIntervalMs ?? 0;
    const retryDelay = Math.max(configuredDelay, outcome.retryAfterMs ?? 0);
    return {
      ...released,
      state: 'retry',
      nextRunAt: new Date(nowMs + retryDelay).toISOString(),
      runRequested: false,
      attempts,
      ...(outcome.errorCode ? { lastErrorCode: outcome.errorCode } : {}),
    };
  }
  const attempts = job.attempts + 1;
  const retryDelay = computeRetryDelay(attempts, {
    ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
    ...(schedule.retryBaseMs !== undefined ? { baseMs: schedule.retryBaseMs } : {}),
    ...(schedule.retryMaxMs !== undefined ? { maxMs: schedule.retryMaxMs } : {}),
    random,
  });
  return {
    ...released,
    state: 'retry',
    nextRunAt: new Date(nowMs + retryDelay).toISOString(),
    runRequested: false,
    attempts,
    ...(outcome.errorCode ? { lastErrorCode: outcome.errorCode } : {}),
  };
}

export function selectClaimableJobs(
  jobs: readonly MonitorJob[],
  now: Date | string | number,
  options: {
    limit: number;
    runningSiteIds?: ReadonlySet<string>;
  },
): MonitorJob[] {
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error('limit must be non-negative');
  const selectedSites = new Set(options.runningSiteIds ?? []);
  return [...jobs]
    .filter((job) => isJobClaimable(job, now))
    .sort(
      (left, right) =>
        timeMilliseconds(left.nextRunAt) - timeMilliseconds(right.nextRunAt) ||
        left.id.localeCompare(right.id),
    )
    .filter((job) => {
      if (selectedSites.has(job.siteId)) return false;
      selectedSites.add(job.siteId);
      return true;
    })
    .slice(0, options.limit);
}

export function setMonitorJobEnabled(
  job: MonitorJob,
  enabled: boolean,
  changedAt: Date | string | number,
): MonitorJob {
  if (!enabled) {
    return {
      ...withoutLease(job),
      state: 'disabled',
      runRequested: false,
    };
  }
  if (job.state !== 'disabled') return { ...job };
  return {
    ...withoutLease(job),
    state: 'queued',
    nextRunAt: isoTime(changedAt),
    runRequested: false,
    attempts: 0,
  };
}

export interface ClaimDueJobsRequest {
  now: string;
  leaseOwner: string;
  leaseUntil: string;
  limit: number;
  excludedSiteIds: readonly string[];
}

export interface FinishPersistedJobRequest {
  jobId: string;
  leaseOwner: string;
  completedAt: string;
  outcome: JobRunOutcome;
  schedule: JobSchedule;
}

export interface PersistentSchedulerStore {
  /** Atomically selects due rows, excludes any site with a live lease, and writes leases. */
  claimDueJobs(request: ClaimDueJobsRequest): Promise<MonitorJob[]>;
  /** Atomically honors the latest runRequested flag while releasing the matching lease. */
  finishJob(request: FinishPersistedJobRequest): Promise<void>;
  requestRun(siteId: string, monitorType: MonitorType, requestedAt: string): Promise<void>;
  releaseLease?(jobId: string, leaseOwner: string, releasedAt: string): Promise<void>;
}

export type MonitorJobRunner = (job: MonitorJob, signal: AbortSignal) => Promise<JobRunOutcome>;

export interface PersistentSchedulerOptions {
  store: PersistentSchedulerStore;
  runner: MonitorJobRunner;
  leaseOwner: string;
  scheduleFor: (job: MonitorJob) => JobSchedule;
  maxConcurrentSites?: number;
  leaseDurationMs?: number;
  now?: () => Date;
  onError?: (error: unknown, job?: MonitorJob) => void;
}

export class PersistentScheduler {
  readonly #store: PersistentSchedulerStore;
  readonly #runner: MonitorJobRunner;
  readonly #leaseOwner: string;
  readonly #scheduleFor: (job: MonitorJob) => JobSchedule;
  readonly #maxConcurrentSites: number;
  readonly #leaseDurationMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown, job?: MonitorJob) => void;
  readonly #running = new Map<string, { job: MonitorJob; controller: AbortController; task: Promise<void> }>();
  #accepting = true;

  constructor(options: PersistentSchedulerOptions) {
    if (!options.leaseOwner) throw new Error('leaseOwner is required');
    this.#store = options.store;
    this.#runner = options.runner;
    this.#leaseOwner = options.leaseOwner;
    this.#scheduleFor = options.scheduleFor;
    this.#maxConcurrentSites = options.maxConcurrentSites ?? 5;
    this.#leaseDurationMs = options.leaseDurationMs ?? 60_000;
    if (!Number.isInteger(this.#maxConcurrentSites) || this.#maxConcurrentSites < 1) {
      throw new Error('maxConcurrentSites must be a positive integer');
    }
    if (!Number.isFinite(this.#leaseDurationMs) || this.#leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be positive');
    }
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
  }

  get runningCount(): number {
    return this.#running.size;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  async tick(): Promise<number> {
    if (!this.#accepting) return 0;
    const capacity = this.#maxConcurrentSites - this.#running.size;
    if (capacity <= 0) return 0;
    const now = this.#now();
    const jobs = await this.#store.claimDueJobs({
      now: now.toISOString(),
      leaseOwner: this.#leaseOwner,
      leaseUntil: new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
      limit: capacity,
      excludedSiteIds: [...this.#running.keys()],
    });
    let started = 0;
    for (const job of jobs) {
      if (this.#running.has(job.siteId) || this.#running.size >= this.#maxConcurrentSites) {
        await this.#store.releaseLease?.(job.id, this.#leaseOwner, this.#now().toISOString());
        continue;
      }
      const controller = new AbortController();
      const task = this.#execute(job, controller).finally(() => this.#running.delete(job.siteId));
      this.#running.set(job.siteId, { job, controller, task });
      started += 1;
    }
    return started;
  }

  async requestRun(siteId: string, monitorType: MonitorType): Promise<void> {
    await this.#store.requestRun(siteId, monitorType, this.#now().toISOString());
  }

  async #execute(job: MonitorJob, controller: AbortController): Promise<void> {
    let outcome: JobRunOutcome;
    try {
      outcome = await this.#runner(job, controller.signal);
    } catch (error) {
      this.#onError(error, job);
      outcome = { success: false, errorCode: 'UNHANDLED_JOB_ERROR' };
    }
    try {
      await this.#store.finishJob({
        jobId: job.id,
        leaseOwner: this.#leaseOwner,
        completedAt: this.#now().toISOString(),
        outcome,
        schedule: this.#scheduleFor(job),
      });
    } catch (error) {
      this.#onError(error, job);
    }
  }

  async stop(options: { abort?: boolean } = {}): Promise<void> {
    this.#accepting = false;
    if (options.abort) {
      for (const running of this.#running.values()) running.controller.abort(new Error('Scheduler stopped'));
    }
    await Promise.allSettled([...this.#running.values()].map((running) => running.task));
  }
}
