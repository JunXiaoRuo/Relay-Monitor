import { and, asc, count, eq, gt, isNull, lte, or } from 'drizzle-orm';

import type { AppContext } from '../context.js';
import {
  monitorJobs,
  rateProbeConfigs,
  rateProbeRuns,
  ratesCurrent,
  sites,
} from '../db/index.js';
import { recoverStaleProbeRuns, runRateProbe } from './rate-probe.js';

const MAX_AUTOMATED_RUNS_PER_24_HOURS = 1_440;
const ACTIVE_PROBE_WINDOW_MS = 2 * 60_000;

export interface RateProbeScheduler {
  tick(): Promise<number>;
  stop(): Promise<void>;
}

export function createRateProbeScheduler(
  context: AppContext,
  onError: (error: unknown) => void,
): RateProbeScheduler {
  const tasks = new Set<Promise<void>>();
  const activeSiteIds = new Set<string>();
  const controllers = new Map<string, AbortController>();
  let stopping = false;
  let ticking = false;

  async function tick(): Promise<number> {
    if (stopping || ticking) return 0;
    ticking = true;
    try {
      recoverStaleProbeRuns(context);
      const now = new Date();
      const nowIso = now.toISOString();
      const activeCutoff = new Date(now.getTime() - ACTIVE_PROBE_WINDOW_MS).toISOString();
      const busySites = new Set([
        ...activeSiteIds,
        ...context.database.db.select({ siteId: monitorJobs.siteId })
          .from(monitorJobs)
          .where(eq(monitorJobs.state, 'running'))
          .all()
          .map((row) => row.siteId),
        ...context.database.db.select({ siteId: rateProbeRuns.siteId })
          .from(rateProbeRuns)
          .where(and(
            eq(rateProbeRuns.status, 'running'),
            or(
              gt(rateProbeRuns.heartbeatAt, activeCutoff),
              and(isNull(rateProbeRuns.heartbeatAt), gt(rateProbeRuns.startedAt, activeCutoff)),
            ),
          ))
          .all()
          .map((row) => row.siteId),
      ]);
      const due = context.database.db.select({
        config: rateProbeConfigs,
        rate: ratesCurrent,
        site: sites,
      })
        .from(rateProbeConfigs)
        .innerJoin(ratesCurrent, eq(ratesCurrent.id, rateProbeConfigs.rateId))
        .innerJoin(sites, eq(sites.id, rateProbeConfigs.siteId))
        .where(and(
          eq(rateProbeConfigs.enabled, true),
          or(isNull(rateProbeConfigs.nextRunAt), lte(rateProbeConfigs.nextRunAt, nowIso)),
          isNull(ratesCurrent.removedAt),
          eq(sites.enabled, true),
          isNull(sites.deletedAt),
        ))
        .orderBy(asc(rateProbeConfigs.nextRunAt), asc(rateProbeConfigs.id))
        .all();

      let started = 0;
      const capacity = Math.max(0, context.config.maxConcurrentSites - busySites.size);
      for (const item of due) {
        if (stopping || started >= capacity) break;
        if (busySites.has(item.site.id)) continue;

        const windowStart = new Date(now.getTime() - 86_400_000).toISOString();
        const recentCount = context.database.db.select({ value: count() })
          .from(rateProbeRuns)
          .where(and(
            eq(rateProbeRuns.rateId, item.rate.id),
            gt(rateProbeRuns.startedAt, windowStart),
          ))
          .get()?.value ?? 0;
        if (recentCount >= MAX_AUTOMATED_RUNS_PER_24_HOURS) {
          const oldest = context.database.db.select({ startedAt: rateProbeRuns.startedAt })
            .from(rateProbeRuns)
            .where(and(
              eq(rateProbeRuns.rateId, item.rate.id),
              gt(rateProbeRuns.startedAt, windowStart),
            ))
            .orderBy(asc(rateProbeRuns.startedAt))
            .get();
          const capReleaseAt = oldest
            ? new Date(Date.parse(oldest.startedAt) + 86_400_000).toISOString()
            : new Date(now.getTime() + item.config.intervalSeconds * 1_000).toISOString();
          context.database.db.update(rateProbeConfigs).set({
            nextRunAt: capReleaseAt,
            updatedAt: nowIso,
          }).where(eq(rateProbeConfigs.id, item.config.id)).run();
          continue;
        }

        const reservedNextRun = new Date(now.getTime() + item.config.intervalSeconds * 1_000).toISOString();
        const reserved = context.database.db.update(rateProbeConfigs).set({
          nextRunAt: reservedNextRun,
          updatedAt: nowIso,
        }).where(and(
          eq(rateProbeConfigs.id, item.config.id),
          eq(rateProbeConfigs.enabled, true),
          item.config.nextRunAt === null
            ? isNull(rateProbeConfigs.nextRunAt)
            : eq(rateProbeConfigs.nextRunAt, item.config.nextRunAt),
        )).run();
        if (reserved.changes !== 1) continue;
        busySites.add(item.site.id);
        activeSiteIds.add(item.site.id);
        const controller = new AbortController();
        controllers.set(item.site.id, controller);
        started += 1;

        let task: Promise<void>;
        task = runRateProbe(context, item.rate.id, undefined, controller.signal)
          .then(() => undefined)
          .catch((error) => onError(error))
          .finally(() => {
            activeSiteIds.delete(item.site.id);
            controllers.delete(item.site.id);
            tasks.delete(task);
          });
        tasks.add(task);
      }
      return started;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    stop: async () => {
      stopping = true;
      for (const controller of controllers.values()) controller.abort(new Error('Rate probe scheduler stopped'));
      await Promise.allSettled([...tasks]);
    },
  };
}
