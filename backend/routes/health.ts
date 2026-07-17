import { existsSync, statSync } from 'node:fs';

import { and, count, eq, inArray, isNotNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import {
  monitorJobs,
  outboxMessages,
} from '../db/index.js';
import { success } from '../core/api-response.js';

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function scalarCount(value: { value: number } | undefined): number {
  return value?.value ?? 0;
}

export async function registerHealthRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/healthz', {
    schema: { hide: true },
  }, async () => ({ status: 'ok' }));

  app.get('/readyz', {
    schema: { hide: true },
  }, async (_request, reply) => {
    try {
      context.database.sqlite.prepare('select 1 as ready').get();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/api/v1/system/status', async (request) => {
    const db = context.database.db;
    const runningJobs = scalarCount(
      db.select({ value: count() }).from(monitorJobs).where(eq(monitorJobs.state, 'running')).get(),
    );
    const queuedJobs = scalarCount(
      db.select({ value: count() }).from(monitorJobs).where(inArray(monitorJobs.state, ['queued', 'retry'])).get(),
    );
    const pendingOutbox = scalarCount(
      db.select({ value: count() }).from(outboxMessages).where(inArray(outboxMessages.state, ['pending', 'retry'])).get(),
    );
    const deadOutbox = scalarCount(
      db.select({ value: count() }).from(outboxMessages).where(eq(outboxMessages.state, 'dead')).get(),
    );
    const lastSuccess = db
      .select({ value: max(monitorJobs.lastSuccessAt) })
      .from(monitorJobs)
      .where(and(isNotNull(monitorJobs.lastSuccessAt), inArray(monitorJobs.state, ['queued', 'retry', 'running'])))
      .get()?.value ?? context.runtime.lastScheduleSuccessAt ?? context.startedAt;
    const memory = process.memoryUsage();

    return success(request, {
      version: '0.1.0',
      started_at: context.startedAt,
      scheduler_running: context.runtime.schedulerRunning,
      scheduler_lag_ms: context.runtime.schedulerLagMs,
      running_jobs: runningJobs,
      queued_jobs: queuedJobs,
      last_schedule_success_at: lastSuccess,
      outbox_pending: pendingOutbox,
      outbox_dead: deadOutbox,
      database_size_bytes: fileSize(context.database.path),
      wal_size_bytes: fileSize(`${context.database.path}-wal`),
      last_backup_at: null,
      event_loop_lag_ms: 0,
      memory_used_bytes: memory.heapUsed,
      memory_total_bytes: memory.rss,
      adapter_versions: context.adapters.manifests().map((manifest) => ({
        type: manifest.adapterType,
        version: manifest.adapterVersion,
        status: 'ready' as const,
      })),
    });
  });
}
