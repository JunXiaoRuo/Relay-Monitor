import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import {
  balanceSnapshots,
  healthChecks,
  monitorJobs,
  rateHistory,
  rateProbeRuns,
  rateSnapshots,
  ratesCurrent,
  sites,
} from '../db/index.js';
import { API_MAX_PAGE_SIZE, RATE_KINDS } from '../../shared/constants.js';
import { success } from '../core/api-response.js';
import { recordAudit } from '../core/audit.js';
import { AppError } from '../core/errors.js';
import { compareDecimals, decimalsEqual, normalizeDecimal } from '../core/decimal.js';
import { latestRateProbe } from '../services/rate-probe.js';
import { excludeAndDeleteRate } from '../services/rate-scope.js';
import { revokeManagedProbeKeysForRate } from '../services/upstream-probe-keys.js';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(API_MAX_PAGE_SIZE).default(50),
});

const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1'),
]);

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function extrema(rows: Array<{ id: string; comparisonKey: string; value: string }>) {
  const result = new Map<string, { lowest: boolean; highest: boolean }>();
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.comparisonKey) ?? [];
    group.push(row);
    groups.set(row.comparisonKey, group);
  }
  for (const group of groups.values()) {
    if (group.length === 0) continue;
    let minimum = normalizeDecimal(group[0]!.value);
    let maximum = minimum;
    for (const row of group.slice(1)) {
      if (compareDecimals(row.value, minimum) < 0) minimum = normalizeDecimal(row.value);
      if (compareDecimals(row.value, maximum) > 0) maximum = normalizeDecimal(row.value);
    }
    for (const row of group) {
      result.set(row.id, {
        lowest: decimalsEqual(row.value, minimum),
        highest: decimalsEqual(row.value, maximum),
      });
    }
  }
  return result;
}

export async function registerMonitorDataRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/api/v1/rates', {
    schema: {
      tags: ['monitoring'],
      summary: '查询当前可信倍率',
      querystring: pageSchema.extend({
        site_id: z.string().max(80).optional(),
        adapter_type: z.string().max(64).optional(),
        rate_kind: z.enum(RATE_KINDS).optional(),
        platform: z.string().max(80).optional(),
        comparison_key: z.string().max(300).optional(),
        availability: z.enum(['available', 'stale', 'unavailable']).optional(),
        changed: queryBooleanSchema.optional(),
        search: z.string().max(120).optional(),
      }),
    },
  }, async (request) => {
    const joined = context.database.db
      .select({ rate: ratesCurrent, site: sites })
      .from(ratesCurrent)
      .innerJoin(sites, eq(ratesCurrent.siteId, sites.id))
      .where(isNull(sites.deletedAt))
      .orderBy(sites.name, ratesCurrent.rateKind, ratesCurrent.name)
      .all();
    const search = request.query.search?.toLocaleLowerCase();
    const filtered = joined.filter(({ rate, site }) =>
      (!request.query.site_id || rate.siteId === request.query.site_id) &&
      (!request.query.adapter_type || site.adapterType === request.query.adapter_type) &&
      (!request.query.rate_kind || rate.rateKind === request.query.rate_kind) &&
      (!request.query.platform || rate.platform === request.query.platform) &&
      (!request.query.comparison_key || rate.comparisonKey === request.query.comparison_key) &&
      (request.query.availability === 'unavailable'
        ? rate.removedAt !== null || rate.metadataStatus === 'unavailable'
        : request.query.availability
          ? rate.removedAt === null && rate.metadataStatus === request.query.availability
          : rate.removedAt === null) &&
      (request.query.changed === undefined || request.query.changed === Boolean(rate.lastChangedAt)) &&
      (!search || rate.name.toLocaleLowerCase().includes(search) || site.name.toLocaleLowerCase().includes(search))
    );
    const rateMonitorJobs = new Map(
      context.database.db.select().from(monitorJobs)
        .where(eq(monitorJobs.monitorType, 'rates'))
        .all()
        .map((job) => [job.siteId, job] as const),
    );
    const comparable = filtered
      .filter(({ rate }) => rate.metadataStatus === 'available' && rate.probeStatus !== 'unavailable')
      .map(({ rate }) => ({ id: rate.id, comparisonKey: rate.comparisonKey, value: rate.value }));
    const flags = extrema(comparable);
    const offset = (request.query.page - 1) * request.query.page_size;
    const items = filtered.slice(offset, offset + request.query.page_size).map(({ rate, site }) => {
      const previous = context.database.db
        .select()
        .from(rateHistory)
        .where(and(eq(rateHistory.siteId, rate.siteId), eq(rateHistory.rateKey, rate.rateKey)))
        .orderBy(desc(rateHistory.confirmedAt))
        .get();
      const flag = flags.get(rate.id);
      const rateMonitor = rateMonitorJobs.get(rate.siteId);
      return {
        id: rate.id,
        site_id: rate.siteId,
        site_name: site.name,
        adapter_type: site.adapterType,
        rate_key: rate.rateKey,
        rate_kind: rate.rateKind,
        name: rate.name,
        platform: rate.platform,
        group: rate.groupName,
        model: rate.model,
        value: normalizeDecimal(rate.value),
        unit: rate.unit,
        comparison_key: rate.comparisonKey,
        billing_expression: rate.billingExpression,
        attributes: parseJson(rate.attributesJson),
        metadata_status: rate.metadataStatus,
        probe_status: rate.probeStatus,
        is_lowest: flag?.lowest ?? false,
        is_highest: flag?.highest ?? false,
        previous_value: previous?.oldValue ?? null,
        last_changed_at: rate.lastChangedAt,
        last_checked_at: rate.lastCheckedAt,
        collected_at: rate.lastCheckedAt,
        match_confidence: rate.matchConfidence,
        latest_probe: latestRateProbe(context, rate.id),
        rate_monitor: rateMonitor ? {
          state: rateMonitor.state,
          last_finished_at: rateMonitor.lastFinishedAt,
          last_success_at: rateMonitor.lastSuccessAt,
          last_error_code: rateMonitor.lastErrorCode,
          last_error_message: rateMonitor.lastErrorMessage,
        } : null,
      };
    });
    return success(request, {
      items,
      page: request.query.page,
      page_size: request.query.page_size,
      total: filtered.length,
    });
  });

  typed.get('/api/v1/rates/:id', {
    schema: {
      tags: ['monitoring'],
      summary: '读取倍率详情',
      params: z.object({ id: z.string().min(1).max(80) }),
    },
  }, async (request) => {
    const rate = context.database.db.select().from(ratesCurrent).where(eq(ratesCurrent.id, request.params.id)).get();
    if (!rate) throw new AppError('RATE_NOT_FOUND', '倍率对象不存在', 404);
    return success(request, {
      ...rate,
      value: normalizeDecimal(rate.value),
      attributes: parseJson(rate.attributesJson),
    });
  });

  typed.delete('/api/v1/rates/:id', {
    schema: {
      tags: ['monitoring'],
      summary: '排除并删除倍率对象',
      params: z.object({ id: z.string().min(1).max(80) }),
    },
  }, async (request) => {
    const runningProbe = context.database.db.select({ id: rateProbeRuns.id })
      .from(rateProbeRuns)
      .where(and(eq(rateProbeRuns.rateId, request.params.id), eq(rateProbeRuns.status, 'running')))
      .get();
    if (runningProbe) {
      throw new AppError('RATE_PROBE_IN_PROGRESS', '模型实测运行期间不能删除该倍率', 409);
    }
    await revokeManagedProbeKeysForRate(context, request.params.id);
    const removed = excludeAndDeleteRate(context, request.params.id);
    recordAudit(context.database, request, {
      action: 'rate.exclude',
      resourceType: 'rate',
      resourceId: request.params.id,
      metadata: {
        site_id: removed.siteId,
        rate_key: removed.rateKey,
        group_id: removed.groupId,
      },
    });
    return success(request, null);
  });

  typed.get('/api/v1/rates/snapshots', {
    schema: {
      tags: ['monitoring'],
      summary: '查询倍率采集质量历史',
      querystring: pageSchema.extend({
        site_id: z.string().max(80).optional(),
        quality: z.enum(['complete', 'partial', 'unsupported']).optional(),
      }),
    },
  }, async (request) => {
    const all = context.database.db.select().from(rateSnapshots)
      .orderBy(desc(rateSnapshots.collectedAt)).all()
      .filter((row) =>
        (!request.query.site_id || row.siteId === request.query.site_id) &&
        (!request.query.quality || row.quality === request.query.quality)
      );
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: all.slice(offset, offset + request.query.page_size).map((row) => ({
        id: row.id,
        site_id: row.siteId,
        quality: row.quality,
        fingerprint: row.fingerprint,
        item_count: row.itemCount,
        errors: JSON.parse(row.errorsJson) as unknown,
        collected_at: row.collectedAt,
      })),
      page: request.query.page,
      page_size: request.query.page_size,
      total: all.length,
    });
  });

  typed.get('/api/v1/rates/:id/history', {
    schema: {
      tags: ['monitoring'],
      summary: '查询倍率确认变化历史',
      params: z.object({ id: z.string().min(1).max(80) }),
      querystring: pageSchema,
    },
  }, async (request) => {
    const rate = context.database.db.select().from(ratesCurrent).where(eq(ratesCurrent.id, request.params.id)).get();
    if (!rate) throw new AppError('RATE_NOT_FOUND', '倍率对象不存在', 404);
    const all = context.database.db.select().from(rateHistory)
      .where(and(eq(rateHistory.siteId, rate.siteId), eq(rateHistory.rateKey, rate.rateKey)))
      .orderBy(desc(rateHistory.confirmedAt)).all();
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: all.slice(offset, offset + request.query.page_size).map((item) => ({
        id: item.id,
        change_type: item.changeType,
        direction: item.direction,
        old_value: item.oldValue,
        new_value: item.newValue,
        old_comparison_key: item.oldComparisonKey,
        new_comparison_key: item.newComparisonKey,
        confirmed_at: item.confirmedAt,
      })),
      page: request.query.page,
      page_size: request.query.page_size,
      total: all.length,
    });
  });

  typed.get('/api/v1/balances/history', {
    schema: {
      tags: ['monitoring'],
      summary: '查询余额历史',
      querystring: pageSchema.extend({
        site_id: z.string().max(80).optional(),
        balance_key: z.string().max(160).optional(),
      }),
    },
  }, async (request) => {
    const all = context.database.db.select().from(balanceSnapshots)
      .orderBy(desc(balanceSnapshots.collectedAt)).all()
      .filter((row) =>
        (!request.query.site_id || row.siteId === request.query.site_id) &&
        (!request.query.balance_key || row.balanceKey === request.query.balance_key)
      );
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: all.slice(offset, offset + request.query.page_size).map((row) => ({
        id: row.id,
        site_id: row.siteId,
        balance_key: row.balanceKey,
        balance_kind: row.balanceKind,
        value: normalizeDecimal(row.value),
        available: row.available,
        frozen: row.frozen,
        total: row.total,
        change_value: row.changeValue,
        currency: row.currency,
        unit: row.unit,
        collected_at: row.collectedAt,
      })),
      page: request.query.page,
      page_size: request.query.page_size,
      total: all.length,
    });
  });

  typed.get('/api/v1/health/history', {
    schema: {
      tags: ['monitoring'],
      summary: '查询连通性历史',
      querystring: pageSchema.extend({ site_id: z.string().max(80).optional() }),
    },
  }, async (request) => {
    const all = context.database.db.select().from(healthChecks)
      .orderBy(desc(healthChecks.checkedAt)).all()
      .filter((row) => !request.query.site_id || row.siteId === request.query.site_id);
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: all.slice(offset, offset + request.query.page_size).map((row) => ({
        id: row.id,
        site_id: row.siteId,
        probe_kind: row.probeKind,
        success: row.success,
        total_ms: row.totalMs,
        http_status: row.httpStatus,
        auth_passed: row.authPassed,
        model_count: row.modelCount,
        error_code: row.errorCode,
        checked_at: row.checkedAt,
      })),
      page: request.query.page,
      page_size: request.query.page_size,
      total: all.length,
    });
  });
}
