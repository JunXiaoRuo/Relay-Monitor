import { describe, expect, it, vi } from 'vitest';

import {
  claimMonitorJob,
  computeJitteredDelay,
  computeRetryDelay,
  finishMonitorJob,
  isJobClaimable,
  PersistentScheduler,
  requestImmediateRun,
  setMonitorJobEnabled,
  selectClaimableJobs,
  type MonitorJob,
  type PersistentSchedulerStore,
} from '../../backend/core/scheduler.js';

function job(overrides: Partial<MonitorJob> = {}): MonitorJob {
  return {
    id: 'job_1',
    siteId: 'site_1',
    monitorType: 'rates',
    state: 'queued',
    nextRunAt: '2026-07-14T00:00:00.000Z',
    attempts: 0,
    runRequested: false,
    ...overrides,
  };
}

describe('persistent scheduler logic', () => {
  it('applies bounded symmetric jitter and honors Retry-After', () => {
    expect(computeJitteredDelay(1_000, 10, () => 0)).toBe(900);
    expect(computeJitteredDelay(1_000, 10, () => 0.5)).toBe(1_000);
    expect(computeJitteredDelay(1_000, 10, () => 1)).toBe(1_100);
    expect(computeRetryDelay(4, { retryAfterMs: 12_345 })).toBe(12_345);
    expect(computeRetryDelay(3, { baseMs: 1_000, maxMs: 10_000, jitterPercent: 0 })).toBe(4_000);
  });

  it('does not reclaim a live lease and reclaims an expired one', () => {
    const running = job({
      state: 'running',
      leaseOwner: 'worker-a',
      leaseUntil: '2026-07-14T00:01:00.000Z',
    });
    expect(isJobClaimable(running, '2026-07-14T00:00:30.000Z')).toBe(false);
    expect(claimMonitorJob(running, 'worker-b', '2026-07-14T00:00:30.000Z', 60_000)).toBeUndefined();
    expect(claimMonitorJob(running, 'worker-b', '2026-07-14T00:01:00.000Z', 60_000)).toMatchObject({
      state: 'running',
      leaseOwner: 'worker-b',
      leaseUntil: '2026-07-14T00:02:00.000Z',
    });
  });

  it('coalesces any number of manual requests into one immediate follow-up run', () => {
    const running = job({
      state: 'running',
      leaseOwner: 'worker-a',
      leaseUntil: '2026-07-14T00:05:00.000Z',
      attempts: 2,
    });
    const once = requestImmediateRun(running, '2026-07-14T00:01:00.000Z');
    const twice = requestImmediateRun(once, '2026-07-14T00:02:00.000Z');
    expect(twice.runRequested).toBe(true);
    const completed = finishMonitorJob(
      twice,
      'worker-a',
      { success: true },
      '2026-07-14T00:03:00.000Z',
      { intervalMs: 300_000, jitterPercent: 10 },
    );
    expect(completed).toMatchObject({
      state: 'queued',
      nextRunAt: '2026-07-14T00:03:00.000Z',
      runRequested: false,
      attempts: 0,
    });

    const waitingRetry = requestImmediateRun(
      job({ state: 'retry', attempts: 2, nextRunAt: '2026-07-14T00:10:00.000Z' }),
      '2026-07-14T00:03:00.000Z',
    );
    expect(waitingRetry).toMatchObject({
      state: 'queued',
      nextRunAt: '2026-07-14T00:03:00.000Z',
      attempts: 0,
    });
  });

  it('schedules normal success and exponential retry without retaining a lease', () => {
    const running = claimMonitorJob(job(), 'worker-a', '2026-07-14T00:00:00.000Z', 60_000)!;
    const success = finishMonitorJob(
      running,
      'worker-a',
      { success: true },
      '2026-07-14T00:00:10.000Z',
      { intervalMs: 300_000, jitterPercent: 0 },
    );
    expect(success.nextRunAt).toBe('2026-07-14T00:05:10.000Z');
    expect(success.leaseOwner).toBeUndefined();

    const retry = finishMonitorJob(
      running,
      'worker-a',
      { success: false, errorCode: 'UPSTREAM_SERVER_ERROR' },
      '2026-07-14T00:00:10.000Z',
      { intervalMs: 300_000, jitterPercent: 0, retryBaseMs: 60_000, retryMaxMs: 900_000 },
      () => 0.5,
    );
    expect(retry).toMatchObject({
      state: 'retry',
      attempts: 1,
      nextRunAt: '2026-07-14T00:01:10.000Z',
      lastErrorCode: 'UPSTREAM_SERVER_ERROR',
    });
  });

  it('uses fixed finite observation retries and returns final failures to normal cadence', () => {
    const schedule = {
      intervalMs: 300_000,
      jitterPercent: 0,
      observationRetryLimit: 2,
      observationRetryIntervalMs: 10_000,
    };
    const first = finishMonitorJob(
      job({ state: 'running', leaseOwner: 'worker-a', attempts: 0 }),
      'worker-a',
      { success: false, retryable: true, errorCode: 'UPSTREAM_UNREACHABLE' },
      '2026-07-14T00:00:10.000Z',
      schedule,
    );
    expect(first).toMatchObject({
      state: 'retry',
      attempts: 1,
      nextRunAt: '2026-07-14T00:00:20.000Z',
    });

    const exhausted = finishMonitorJob(
      job({ state: 'running', leaseOwner: 'worker-a', attempts: 2 }),
      'worker-a',
      { success: false, retryable: true, errorCode: 'UPSTREAM_UNREACHABLE' },
      '2026-07-14T00:00:10.000Z',
      schedule,
    );
    expect(exhausted).toMatchObject({
      state: 'queued',
      attempts: 0,
      nextRunAt: '2026-07-14T00:05:10.000Z',
    });

    const terminal = finishMonitorJob(
      job({ state: 'running', leaseOwner: 'worker-a', attempts: 0 }),
      'worker-a',
      { success: false, retryable: false, errorCode: 'AUTH_INVALID_CREDENTIALS' },
      '2026-07-14T00:00:10.000Z',
      schedule,
    );
    expect(terminal).toMatchObject({
      state: 'queued',
      attempts: 0,
      nextRunAt: '2026-07-14T00:05:10.000Z',
    });
  });

  it('selects at most one task per site and respects the global capacity', () => {
    const selected = selectClaimableJobs(
      [
        job({ id: 'job_1', siteId: 'site_1', monitorType: 'rates' }),
        job({ id: 'job_2', siteId: 'site_1', monitorType: 'balance' }),
        job({ id: 'job_3', siteId: 'site_2', monitorType: 'connectivity' }),
        job({ id: 'job_4', siteId: 'site_3', monitorType: 'auth' }),
      ],
      '2026-07-14T00:00:00.000Z',
      { limit: 2 },
    );
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map((item) => item.siteId)).size).toBe(2);
  });

  it('disables without scheduling a fake run and enables with one immediate baseline run', () => {
    const disabled = setMonitorJobEnabled(job(), false, '2026-07-14T00:00:00.000Z');
    expect(disabled).toMatchObject({ state: 'disabled', runRequested: false });
    expect(isJobClaimable(disabled, '2026-07-15T00:00:00.000Z')).toBe(false);
    const enabled = setMonitorJobEnabled(disabled, true, '2026-07-14T01:00:00.000Z');
    expect(enabled).toMatchObject({
      state: 'queued',
      nextRunAt: '2026-07-14T01:00:00.000Z',
      attempts: 0,
    });
  });

  it('enforces the configured in-process capacity around a persistent store', async () => {
    const claimed = [
      job({ id: 'job_1', siteId: 'site_1', state: 'running', leaseOwner: 'worker', leaseUntil: '2026-07-14T00:01:00Z' }),
      job({ id: 'job_2', siteId: 'site_2', state: 'running', leaseOwner: 'worker', leaseUntil: '2026-07-14T00:01:00Z' }),
      job({ id: 'job_3', siteId: 'site_3', state: 'running', leaseOwner: 'worker', leaseUntil: '2026-07-14T00:01:00Z' }),
    ];
    const finishJob = vi.fn<PersistentSchedulerStore['finishJob']>(async () => undefined);
    const store: PersistentSchedulerStore = {
      claimDueJobs: vi.fn(async (request) => claimed.slice(0, request.limit)),
      finishJob,
      requestRun: vi.fn(async () => undefined),
    };
    const releases: Array<() => void> = [];
    const runner = vi.fn(async () =>
      new Promise<{ success: true }>((resolve) => releases.push(() => resolve({ success: true }))),
    );
    const scheduler = new PersistentScheduler({
      store,
      runner,
      leaseOwner: 'worker',
      maxConcurrentSites: 2,
      leaseDurationMs: 60_000,
      now: () => new Date('2026-07-14T00:00:00Z'),
      scheduleFor: () => ({ intervalMs: 60_000, jitterPercent: 0 }),
    });

    expect(await scheduler.tick()).toBe(2);
    expect(scheduler.runningCount).toBe(2);
    expect(runner).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await scheduler.stop();
    expect(finishJob).toHaveBeenCalledTimes(2);
    expect(scheduler.runningCount).toBe(0);
  });
});
