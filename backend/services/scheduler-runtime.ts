import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';

import type { MonitorType } from '../adapters/index.js';
import type { AppContext } from '../context.js';
import { monitorConfigs, monitorJobs, rateProbeRuns, sites } from '../db/index.js';
import {
  finishMonitorJob,
  PersistentScheduler,
  requestImmediateRun,
  type ClaimDueJobsRequest,
  type FinishPersistedJobRequest,
  type JobSchedule,
  type MonitorJob,
  type PersistentSchedulerStore,
} from '../core/scheduler.js';
import { createId } from '../core/ids.js';
import {
  DEFAULT_MONITOR_RETRY_COUNT,
  DEFAULT_MONITOR_RETRY_INTERVAL_SECONDS,
} from '../../shared/constants.js';
import { reconcileAdapterStates, refreshSiteCapabilitiesIfDue } from './adapter-reconciler.js';
import { runMonitor } from './monitor-runner.js';
import { createRateProbeScheduler } from './rate-probe-scheduler.js';

function coreJob(row: typeof monitorJobs.$inferSelect): MonitorJob {
  return {
    id: row.id,
    siteId: row.siteId,
    monitorType: row.monitorType as MonitorType,
    state: row.state as MonitorJob['state'],
    nextRunAt: row.nextRunAt,
    attempts: row.attempts,
    runRequested: row.runRequested,
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseUntil ? { leaseUntil: row.leaseUntil } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
  };
}

class SqliteSchedulerStore implements PersistentSchedulerStore {
  readonly #context: AppContext;

  constructor(context: AppContext) {
    this.#context = context;
  }

  async claimDueJobs(request: ClaimDueJobsRequest): Promise<MonitorJob[]> {
    return this.#context.database.sqlite.transaction(() => {
      const activeSiteIds = this.#context.database.db
        .select({ siteId: monitorJobs.siteId })
        .from(monitorJobs)
        .where(and(eq(monitorJobs.state, 'running'), gt(monitorJobs.leaseUntil, request.now)))
        .all()
        .map((row) => row.siteId);
      const activeProbeSiteIds = this.#context.database.db
        .select({ siteId: rateProbeRuns.siteId })
        .from(rateProbeRuns)
        .where(and(
          eq(rateProbeRuns.status, 'running'),
          gt(
            rateProbeRuns.startedAt,
            new Date(Date.parse(request.now) - 2 * 60_000).toISOString(),
          ),
        ))
        .all()
        .map((row) => row.siteId);
      const candidates = this.#context.database.db.select().from(monitorJobs).where(or(
        and(inArray(monitorJobs.state, ['queued', 'retry']), lte(monitorJobs.nextRunAt, request.now)),
        and(eq(monitorJobs.state, 'running'), or(isNull(monitorJobs.leaseUntil), lte(monitorJobs.leaseUntil, request.now))),
      )).orderBy(monitorJobs.nextRunAt).all();
      const excluded = new Set([...request.excludedSiteIds, ...activeSiteIds, ...activeProbeSiteIds]);
      const claimLimit = Math.max(0, request.limit - new Set(activeProbeSiteIds).size);
      const claimed: MonitorJob[] = [];
      for (const row of candidates) {
        if (claimed.length >= claimLimit) break;
        if (excluded.has(row.siteId)) continue;
        const runnable = this.#context.database.db
          .select({ siteEnabled: sites.enabled, monitorEnabled: monitorConfigs.enabled })
          .from(sites)
          .innerJoin(monitorConfigs, and(
            eq(monitorConfigs.siteId, sites.id),
            eq(monitorConfigs.monitorType, row.monitorType),
          ))
          .where(and(eq(sites.id, row.siteId), isNull(sites.deletedAt)))
          .get();
        if (!runnable?.siteEnabled || !runnable.monitorEnabled) {
          this.#context.database.db.update(monitorJobs).set({
            state: 'disabled',
            leaseOwner: null,
            leaseUntil: null,
            runRequested: false,
            updatedAt: request.now,
          }).where(eq(monitorJobs.id, row.id)).run();
          continue;
        }
        excluded.add(row.siteId);
        const updated = this.#context.database.db.update(monitorJobs).set({
          state: 'running',
          leaseOwner: request.leaseOwner,
          leaseUntil: request.leaseUntil,
          lastStartedAt: request.now,
          updatedAt: request.now,
        }).where(eq(monitorJobs.id, row.id)).returning().get();
        if (updated) claimed.push(coreJob(updated));
      }
      return claimed;
    })();
  }

  async finishJob(request: FinishPersistedJobRequest): Promise<void> {
    this.#context.database.sqlite.transaction(() => {
      const persisted = this.#context.database.db.select().from(monitorJobs)
        .where(eq(monitorJobs.id, request.jobId)).get();
      if (!persisted || persisted.state !== 'running' || persisted.leaseOwner !== request.leaseOwner) return;
      const monitorConfig = this.#context.database.db.select().from(monitorConfigs).where(and(
        eq(monitorConfigs.siteId, persisted.siteId),
        eq(monitorConfigs.monitorType, persisted.monitorType),
      )).get();
      const site = this.#context.database.db.select({ enabled: sites.enabled, deletedAt: sites.deletedAt })
        .from(sites).where(eq(sites.id, persisted.siteId)).get();
      if (!monitorConfig?.enabled || !site?.enabled || site.deletedAt) {
        this.#context.database.db.update(monitorJobs).set({
          state: 'disabled',
          leaseOwner: null,
          leaseUntil: null,
          runRequested: false,
          lastFinishedAt: request.completedAt,
          updatedAt: request.completedAt,
        }).where(eq(monitorJobs.id, request.jobId)).run();
        return;
      }
      const finished = finishMonitorJob(
        coreJob(persisted),
        request.leaseOwner,
        request.outcome,
        request.completedAt,
        request.schedule,
      );
      this.#context.database.db.update(monitorJobs).set({
        state: finished.state,
        nextRunAt: finished.nextRunAt,
        leaseOwner: null,
        leaseUntil: null,
        attempts: finished.attempts,
        runRequested: finished.runRequested,
        retryAfter: finished.state === 'retry' ? finished.nextRunAt : null,
        lastFinishedAt: request.completedAt,
        ...(request.outcome.success ? {
          lastSuccessAt: request.completedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
        } : {
          lastErrorCode: request.outcome.errorCode ?? 'MONITOR_FAILED',
          lastErrorMessage: request.outcome.errorMessage
            ?? (request.outcome.errorCode
              ? `监控任务执行失败（${request.outcome.errorCode}）`
              : '监控任务执行失败'),
        }),
        updatedAt: request.completedAt,
      }).where(eq(monitorJobs.id, request.jobId)).run();
    })();
  }

  async requestRun(siteId: string, monitorType: MonitorType, requestedAt: string): Promise<void> {
    this.#context.database.sqlite.transaction(() => {
      const row = this.#context.database.db.select().from(monitorJobs).where(and(
        eq(monitorJobs.siteId, siteId), eq(monitorJobs.monitorType, monitorType),
      )).get();
      if (!row) return;
      const requested = requestImmediateRun(coreJob(row), requestedAt);
      this.#context.database.db.update(monitorJobs).set({
        state: requested.state,
        nextRunAt: requested.nextRunAt,
        runRequested: requested.runRequested,
        ...(requested.leaseOwner === undefined ? {} : { leaseOwner: requested.leaseOwner }),
        ...(requested.leaseUntil === undefined ? {} : { leaseUntil: requested.leaseUntil }),
        updatedAt: requestedAt,
      }).where(eq(monitorJobs.id, row.id)).run();
    })();
  }

  async releaseLease(jobId: string, leaseOwner: string, releasedAt: string): Promise<void> {
    this.#context.database.db.update(monitorJobs).set({
      state: 'queued',
      nextRunAt: releasedAt,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: releasedAt,
    }).where(and(eq(monitorJobs.id, jobId), eq(monitorJobs.leaseOwner, leaseOwner))).run();
  }
}

export interface SchedulerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<number>;
}

export function createSchedulerRuntime(
  context: AppContext,
  onError: (error: unknown, job?: MonitorJob) => void,
): SchedulerRuntime {
  const store = new SqliteSchedulerStore(context);
  const leaseDurationMs = 10 * 60_000;
  const scheduleFor = (job: MonitorJob): JobSchedule => {
    const config = context.database.db.select().from(monitorConfigs).where(and(
      eq(monitorConfigs.siteId, job.siteId), eq(monitorConfigs.monitorType, job.monitorType),
    )).get();
    return {
      intervalMs: (config?.intervalSeconds ?? 300) * 1_000,
      jitterPercent: config?.scheduleJitterPercent ?? 10,
      observationRetryLimit: config?.retryCount ?? DEFAULT_MONITOR_RETRY_COUNT,
      observationRetryIntervalMs: (config?.retryIntervalSeconds ?? DEFAULT_MONITOR_RETRY_INTERVAL_SECONDS) * 1_000,
      retryBaseMs: 60_000,
      retryMaxMs: 60 * 60_000,
    };
  };
  const scheduler = new PersistentScheduler({
    store,
    leaseOwner: createId('worker'),
    maxConcurrentSites: context.config.maxConcurrentSites,
    leaseDurationMs,
    scheduleFor,
    onError,
    runner: async (job, signal) => {
      const leaseIsValid = (): boolean => {
        if (!job.leaseOwner) return false;
        const persisted = context.database.db
          .select({
            state: monitorJobs.state,
            leaseOwner: monitorJobs.leaseOwner,
            leaseUntil: monitorJobs.leaseUntil,
            monitorEnabled: monitorConfigs.enabled,
            siteEnabled: sites.enabled,
          })
          .from(monitorJobs)
          .innerJoin(monitorConfigs, and(
            eq(monitorConfigs.siteId, monitorJobs.siteId),
            eq(monitorConfigs.monitorType, monitorJobs.monitorType),
          ))
          .innerJoin(sites, eq(sites.id, monitorJobs.siteId))
          .where(eq(monitorJobs.id, job.id))
          .get();
        return Boolean(
          persisted &&
          persisted.state === 'running' &&
          persisted.monitorEnabled &&
          persisted.siteEnabled &&
          persisted.leaseOwner === job.leaseOwner &&
          persisted.leaseUntil &&
          persisted.leaseUntil > new Date().toISOString(),
        );
      };
      const renewLease = (): void => {
        if (!job.leaseOwner) return;
        context.database.db.update(monitorJobs).set({
          leaseUntil: new Date(Date.now() + leaseDurationMs).toISOString(),
          updatedAt: new Date().toISOString(),
        }).where(and(
          eq(monitorJobs.id, job.id),
          eq(monitorJobs.state, 'running'),
          eq(monitorJobs.leaseOwner, job.leaseOwner),
        )).run();
      };
      const heartbeat = setInterval(renewLease, 15_000);
      heartbeat.unref();
      try {
        await refreshSiteCapabilitiesIfDue(context, job.siteId, {
          signal,
          leaseIsValid,
        });
        if (!leaseIsValid()) return { success: false, errorCode: 'LEASE_LOST' };
        const result = await runMonitor(
          context,
          job.siteId,
          job.monitorType,
          signal,
          leaseIsValid,
          job.attempts,
        );
        if (result.success) {
          context.runtime.lastScheduleSuccessAt = new Date().toISOString();
        }
        return result;
      } finally {
        clearInterval(heartbeat);
      }
    },
  });
  const probeScheduler = createRateProbeScheduler(context, (error) => onError(error));
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;

  async function tick(): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    try {
      const now = new Date();
      const oldestDue = context.database.db
        .select({ nextRunAt: monitorJobs.nextRunAt })
        .from(monitorJobs)
        .where(and(
          inArray(monitorJobs.state, ['queued', 'retry']),
          lte(monitorJobs.nextRunAt, now.toISOString()),
        ))
        .orderBy(monitorJobs.nextRunAt)
        .get();
      context.runtime.schedulerLagMs = oldestDue
        ? Math.max(0, now.getTime() - Date.parse(oldestDue.nextRunAt))
        : 0;
      const started = await scheduler.tick();
      const probesStarted = await probeScheduler.tick();
      return started + probesStarted;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start: async () => {
      if (timer) return;
      reconcileAdapterStates(context);
      context.runtime.schedulerRunning = true;
      await tick();
      timer = setInterval(() => void tick().catch((error) => onError(error)), 1_000);
      timer.unref();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      context.runtime.schedulerRunning = false;
      await scheduler.stop();
      await probeScheduler.stop();
    },
  };
}
