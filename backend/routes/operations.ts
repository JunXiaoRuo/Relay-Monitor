import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { paginationSchema } from '../../shared/schemas.js';
import type { AppContext } from '../context.js';
import { success } from '../core/api-response.js';
import { recordAudit } from '../core/audit.js';
import { AppError } from '../core/errors.js';
import { createId } from '../core/ids.js';
import {
  isMaintenanceWindowActive,
  isValidCronExpression,
} from '../core/maintenance.js';
import { redact } from '../core/redaction.js';
import {
  admins,
  auditLogs,
  maintenanceWindows,
  silences,
  sites,
} from '../db/index.js';

const idParamsSchema = z.object({ id: z.string().min(1).max(80) });
const MAX_AUDIT_LOG_BATCH_DELETE = 100;
const auditLogIdSchema = z.string().trim().min(1).max(80);
const batchDeleteAuditLogsSchema = z.object({
  ids: z.array(auditLogIdSchema).min(1).max(MAX_AUDIT_LOG_BATCH_DELETE),
}).refine(({ ids }) => new Set(ids).size === ids.length, {
  path: ['ids'],
  message: '审计记录 ID 不能重复',
});
const deleteAuditLogsByTimeSchema = z.object({
  before: z.string().datetime({ offset: true }).max(64),
});
const jsonObjectSchema = z.record(z.string().min(1).max(128), z.json());
const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1'),
]);
const rfc3339Schema = z.string().datetime({ offset: true }).max(64);
const timezoneSchema = z.string().trim().min(1).max(100).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, 'IANA 时区名称无效');
const cronExpressionSchema = z.string().trim().min(9).max(200)
  .refine((value) => value.split(/\s+/).length === 5, 'Cron 表达式必须包含五个字段')
  .refine((value) => /^[\d*/?,\-\s]+$/.test(value), 'Cron 表达式包含不支持的字符')
  .refine(isValidCronExpression, 'Cron 表达式无效');
const maintenanceTimestampSchema = z.union([
  rfc3339Schema,
  z.string().trim().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value)), '日期时间格式无效'),
]);

const maintenanceFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  active: z.boolean().optional(),
  kind: z.enum(['manual', 'once', 'cron']).optional(),
  schedule_type: z.enum(['manual', 'once', 'cron']).optional(),
  matcher: jsonObjectSchema.optional(),
  scope: jsonObjectSchema.optional(),
  starts_at: z.union([maintenanceTimestampSchema, z.literal('')]).nullable().optional(),
  ends_at: z.union([maintenanceTimestampSchema, z.literal('')]).nullable().optional(),
  cron_expression: cronExpressionSchema.nullable().optional(),
  cron: cronExpressionSchema.nullable().optional(),
  duration_seconds: z.number().int().min(60).max(365 * 24 * 60 * 60).nullable().optional(),
  timezone: timezoneSchema.optional(),
  reason: z.string().trim().max(1_000).optional(),
}).superRefine((input, context) => {
  if (input.kind === undefined && input.schedule_type === undefined) {
    context.addIssue({ code: 'custom', path: ['kind'], message: '必须填写维护类型' });
  }
  if (input.kind && input.schedule_type && input.kind !== input.schedule_type) {
    context.addIssue({ code: 'custom', path: ['schedule_type'], message: '两个维护类型字段必须一致' });
  }
});

const patchMaintenanceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  kind: z.enum(['manual', 'once', 'cron']).optional(),
  schedule_type: z.enum(['manual', 'once', 'cron']).optional(),
  matcher: jsonObjectSchema.optional(),
  scope: jsonObjectSchema.optional(),
  starts_at: z.union([maintenanceTimestampSchema, z.literal('')]).nullable().optional(),
  ends_at: z.union([maintenanceTimestampSchema, z.literal('')]).nullable().optional(),
  cron_expression: cronExpressionSchema.nullable().optional(),
  cron: cronExpressionSchema.nullable().optional(),
  duration_seconds: z.number().int().min(60).max(365 * 24 * 60 * 60).nullable().optional(),
  timezone: timezoneSchema.optional(),
  reason: z.string().trim().max(1_000).optional(),
})
  .refine((input) => Object.keys(input).length > 0, '至少填写一个要修改的字段');

const createSilenceSchema = z.object({
  matcher: jsonObjectSchema,
  reason: z.string().trim().min(1).max(1_000),
  starts_at: rfc3339Schema.optional(),
  ends_at: rfc3339Schema.optional(),
  duration_seconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
}).superRefine((input, context) => {
  if (input.ends_at === undefined && input.duration_seconds === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['ends_at'],
      message: '必须填写结束时间或持续时间',
    });
  }
  if (input.ends_at !== undefined && input.duration_seconds !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['duration_seconds'],
      message: '结束时间和持续时间只能填写一项',
    });
  }
});

const patchSilenceSchema = z.object({
  matcher: jsonObjectSchema.optional(),
  reason: z.string().trim().min(1).max(1_000).optional(),
  starts_at: rfc3339Schema.optional(),
  ends_at: rfc3339Schema.optional(),
  duration_seconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
  active: z.boolean().optional(),
})
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({ code: 'custom', message: '至少填写一个要修改的字段' });
    }
    if (input.ends_at !== undefined && input.duration_seconds !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['duration_seconds'],
        message: '结束时间和持续时间只能填写一项',
      });
    }
  });

type MaintenanceRow = typeof maintenanceWindows.$inferSelect;
type SilenceRow = typeof silences.$inferSelect;

interface MaintenanceValues {
  kind: 'manual' | 'once' | 'cron';
  startsAt: string | null;
  endsAt: string | null;
  cronExpression: string | null;
  durationSeconds: number | null;
  timezone: string;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new AppError('INVALID_TIMESTAMP', '时间必须是有效的 RFC 3339 格式', 400);
  return new Date(milliseconds).toISOString();
}

function escapedLikePattern(value: string): string {
  return `%${value.toLowerCase().replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
}

function auditResult(action: string): 'failed' | 'success' {
  return /(?:failed|error|denied)$/.test(action) ? 'failed' : 'success';
}

function auditLogDto(row: typeof auditLogs.$inferSelect) {
  return {
    id: row.id,
    admin_id: row.adminId,
    actor: row.adminId ?? 'system',
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    target: row.resourceId ? `${row.resourceType}:${row.resourceId}` : row.resourceType,
    result: auditResult(row.action),
    request_id: row.requestId,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    metadata: redact(parseObject(row.metadataJson)),
    created_at: row.createdAt,
  };
}

function deleteAuditLogRecords(
  context: AppContext,
  ids: readonly string[],
  batch: boolean,
): number {
  return context.database.sqlite.transaction(() => {
    const rows = context.database.db.select().from(auditLogs).where(and(
      inArray(auditLogs.id, [...ids]),
      isNull(auditLogs.deletedAt),
    )).all();
    if (rows.length !== ids.length) {
      throw new AppError(
        batch ? 'AUDIT_LOG_BATCH_CONFLICT' : 'AUDIT_LOG_NOT_FOUND',
        batch ? '部分审计记录不存在，请刷新后重试' : '审计记录不存在',
        batch ? 409 : 404,
        batch ? { requested_count: ids.length, available_count: rows.length } : {},
      );
    }

    const deleted = context.database.db.delete(auditLogs).where(and(
      inArray(auditLogs.id, [...ids]),
      isNull(auditLogs.deletedAt),
    )).run();
    if (deleted.changes !== rows.length) {
      throw new AppError(
        batch ? 'AUDIT_LOG_BATCH_CONFLICT' : 'AUDIT_LOG_NOT_FOUND',
        batch ? '审计记录状态已变化，请刷新后重试' : '审计记录不存在',
        batch ? 409 : 404,
      );
    }
    return rows.length;
  }).immediate();
}

function deleteAuditLogsBefore(context: AppContext, before: string): number {
  return context.database.sqlite.transaction(() =>
    context.database.db.delete(auditLogs).where(lte(auditLogs.createdAt, before)).run().changes
  ).immediate();
}

function deleteAllAuditLogs(context: AppContext): number {
  return context.database.sqlite.transaction(() => context.database.db.delete(auditLogs).run().changes).immediate();
}

function validateTimeRange(startsAt: string, endsAt: string): void {
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new AppError('INVALID_TIME_RANGE', '结束时间必须晚于开始时间', 400);
  }
}

const eventTypeLabels: Readonly<Record<string, string>> = {
  'site.network_unreachable': '网络不可达',
  'site.timeout': '请求超时',
  'site.auth_expired': '认证失效',
  'site.permission_denied': '权限拒绝',
  'site.rate_limited': '上游限流',
  'site.upstream_5xx': '上游服务异常',
  'site.schema_incompatible': '响应结构不兼容',
  'site.other_error': '其他站点异常',
  'site.recovered': '恢复上线',
  'rate.changed': '倍率变化',
  'rate.added': '倍率新增',
  'rate.removed': '倍率移除',
  'rate.threshold': '倍率阈值',
  'probe.input_tokens_high': '输入 Token 异常',
  'probe.unexpected_tool_calls': '意外工具调用',
  'probe.prompt_interference': '提示词疑似干扰',
  'probe.model_mismatch': '模型声明不匹配',
  'probe.failed': '模型实测失败',
  'probe.recovered': '模型实测恢复',
  'balance.low': '余额过低',
  'balance.threshold': '余额阈值',
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function suppressionMatcherLabel(
  matcher: Record<string, unknown>,
  siteNames: ReadonlyMap<string, string>,
  fallback: string,
): string {
  const parts: string[] = [];
  const siteIds = stringArray(matcher.site_ids);
  if (siteIds.length > 0) {
    const names = siteIds.map((id) => siteNames.get(id) ?? '已删除站点');
    parts.push(`站点：${names.join('、')}`);
  }
  const tags = stringArray(matcher.tags);
  if (tags.length > 0) parts.push(`标签：${tags.join('、')}`);
  const eventTypes = stringArray(matcher.event_types);
  if (eventTypes.length > 0) {
    parts.push(`事件：${eventTypes.map((item) => eventTypeLabels[item] ?? '其他事件').join('、')}`);
  }
  const severities = stringArray(matcher.severities);
  if (severities.length > 0) {
    const severityLabels: Readonly<Record<string, string>> = { info: '信息', warning: '警告', critical: '严重' };
    parts.push(`严重度：${severities.map((item) => severityLabels[item] ?? item).join('、')}`);
  }
  const incidentIds = stringArray(matcher.incident_ids);
  if (incidentIds.length > 0) parts.push(`指定事件（${incidentIds.length} 条）`);
  if (parts.length > 0) return parts.join('；');
  return Object.keys(matcher).length > 0 ? '自定义范围' : fallback;
}

function siteNameMap(context: AppContext): Map<string, string> {
  return new Map(context.database.db.select({ id: sites.id, name: sites.name }).from(sites).all()
    .map((site) => [site.id, site.name]));
}

function adminNameMap(context: AppContext): Map<string, string> {
  return new Map(context.database.db.select({ id: admins.id, displayName: admins.displayName }).from(admins).all()
    .map((admin) => [admin.id, admin.displayName]));
}

function normalizeMaintenance(input: {
  kind: 'manual' | 'once' | 'cron';
  starts_at?: string | null | undefined;
  ends_at?: string | null | undefined;
  cron_expression?: string | null | undefined;
  duration_seconds?: number | null | undefined;
  timezone?: string | undefined;
}, defaultTimezone: string): MaintenanceValues {
  const timezone = input.timezone ?? defaultTimezone;
  if (input.kind === 'cron') {
    if (!input.cron_expression) {
      throw new AppError(
        'INVALID_MAINTENANCE_WINDOW',
        'Cron 周期维护必须填写 Cron 表达式',
        400,
      );
    }
    return {
      kind: input.kind,
      startsAt: null,
      endsAt: null,
      cronExpression: input.cron_expression,
      durationSeconds: input.duration_seconds ?? 3_600,
      timezone,
    };
  }

  const startsAt = input.starts_at ? normalizedTimestamp(input.starts_at) : new Date().toISOString();
  const endsAt = input.ends_at ? normalizedTimestamp(input.ends_at) : null;
  if (input.kind === 'once' && endsAt === null) {
    throw new AppError('INVALID_MAINTENANCE_WINDOW', '单次维护必须填写结束时间', 400);
  }
  if (endsAt !== null) validateTimeRange(startsAt, endsAt);
  return {
    kind: input.kind,
    startsAt,
    endsAt,
    cronExpression: null,
    durationSeconds: null,
    timezone,
  };
}

function maintenanceDto(row: MaintenanceRow, siteNames: ReadonlyMap<string, string>) {
  const matcher = parseObject(row.matcherJson);
  const active = isMaintenanceWindowActive(row);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    kind: row.kind,
    schedule_type: row.kind,
    matcher,
    scope_label: suppressionMatcherLabel(matcher, siteNames, '全部站点'),
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    cron_expression: row.cronExpression,
    duration_seconds: row.durationSeconds,
    timezone: row.timezone,
    active,
    reason: row.reason,
    created_by_admin_id: row.createdByAdminId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function requireMaintenance(context: AppContext, id: string): MaintenanceRow {
  const row = context.database.db.select().from(maintenanceWindows)
    .where(and(eq(maintenanceWindows.id, id), isNull(maintenanceWindows.deletedAt))).get();
  if (!row) throw new AppError('MAINTENANCE_WINDOW_NOT_FOUND', '维护窗口不存在', 404);
  return row;
}

function silenceDto(
  row: SilenceRow,
  siteNames: ReadonlyMap<string, string>,
  adminNames: ReadonlyMap<string, string>,
) {
  const matcher = parseObject(row.matcherJson);
  const now = new Date().toISOString();
  return {
    id: row.id,
    matcher: suppressionMatcherLabel(matcher, siteNames, '全部事件'),
    matcher_config: matcher,
    reason: row.reason,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    created_by_admin_id: row.createdByAdminId,
    created_by: row.createdByAdminId === null
      ? '系统'
      : adminNames.get(row.createdByAdminId) ?? '已删除管理员',
    created_at: row.createdAt,
    deleted_at: row.deletedAt,
    expires_at: row.endsAt,
    active: row.deletedAt === null && row.startsAt <= now && row.endsAt > now,
  };
}

function requireSilence(context: AppContext, id: string): SilenceRow {
  const row = context.database.db.select().from(silences).where(eq(silences.id, id)).get();
  if (!row) throw new AppError('SILENCE_NOT_FOUND', '临时静默不存在', 404);
  return row;
}

function backupFileName(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `relay-monitor-${timestamp}-${createId('backup').slice(-8)}.db`;
}

export async function registerOperationRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/api/v1/maintenance-windows', {
    schema: {
      tags: ['operations'], summary: 'Create a maintenance window', body: maintenanceFieldsSchema,
    },
  }, async (request, reply) => {
    const id = createId('maint');
    const kind = request.body.kind ?? request.body.schedule_type;
    if (!kind) throw new AppError('INVALID_MAINTENANCE_WINDOW', '必须选择维护计划类型', 400);
    const normalized = normalizeMaintenance({
      kind,
      starts_at: request.body.starts_at || null,
      ends_at: request.body.ends_at || null,
      cron_expression: request.body.cron_expression ?? request.body.cron,
      duration_seconds: request.body.duration_seconds,
      timezone: request.body.timezone,
    }, context.config.timezone);
    const matcher = request.body.matcher ?? request.body.scope ?? {};
    const now = new Date().toISOString();
    context.database.db.insert(maintenanceWindows).values({
      id,
      name: request.body.name,
      enabled: request.body.active ?? request.body.enabled,
      kind: normalized.kind,
      matcherJson: JSON.stringify(matcher),
      startsAt: normalized.startsAt,
      endsAt: normalized.endsAt,
      cronExpression: normalized.cronExpression,
      durationSeconds: normalized.durationSeconds,
      timezone: normalized.timezone,
      reason: request.body.reason ?? '',
      createdByAdminId: request.relayAdmin?.id ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();
    recordAudit(context.database, request, {
      action: 'maintenance_window.create', resourceType: 'maintenance_window', resourceId: id,
      metadata: { kind: normalized.kind, reason_present: Boolean(request.body.reason) },
    });
    reply.code(201);
    return success(request, maintenanceDto(requireMaintenance(context, id), siteNameMap(context)));
  });

  typed.get('/api/v1/maintenance-windows', {
    schema: {
      tags: ['operations'], summary: 'List maintenance windows', querystring: paginationSchema,
    },
  }, async (request) => {
    const where = isNull(maintenanceWindows.deletedAt);
    const offset = (request.query.page - 1) * request.query.page_size;
    const rows = context.database.db.select().from(maintenanceWindows)
      .where(where)
      .orderBy(desc(maintenanceWindows.createdAt))
      .limit(request.query.page_size)
      .offset(offset)
      .all();
    const total = context.database.db.select({ value: count() }).from(maintenanceWindows).where(where).get()?.value ?? 0;
    const names = siteNameMap(context);
    return success(request, {
      items: rows.map((row) => maintenanceDto(row, names)),
      page: request.query.page,
      page_size: request.query.page_size,
      total,
    });
  });

  typed.get('/api/v1/maintenance-windows/:id', {
    schema: { tags: ['operations'], summary: 'Read a maintenance window', params: idParamsSchema },
  }, async (request) => success(
    request,
    maintenanceDto(requireMaintenance(context, request.params.id), siteNameMap(context)),
  ));

  typed.patch('/api/v1/maintenance-windows/:id', {
    schema: {
      tags: ['operations'], summary: 'Update a maintenance window', params: idParamsSchema, body: patchMaintenanceSchema,
    },
  }, async (request) => {
    const current = requireMaintenance(context, request.params.id);
    if (request.body.kind && request.body.schedule_type && request.body.kind !== request.body.schedule_type) {
      throw new AppError('INVALID_MAINTENANCE_WINDOW', '维护计划类型字段不一致', 400);
    }
    const kind = request.body.kind ?? request.body.schedule_type ?? current.kind as MaintenanceValues['kind'];
    const normalized = normalizeMaintenance({
      kind,
      starts_at: request.body.starts_at === undefined ? current.startsAt : request.body.starts_at || null,
      ends_at: request.body.ends_at === undefined ? current.endsAt : request.body.ends_at || null,
      cron_expression: request.body.cron_expression === undefined && request.body.cron === undefined
        ? current.cronExpression
        : request.body.cron_expression ?? request.body.cron,
      duration_seconds: request.body.duration_seconds === undefined
        ? current.durationSeconds
        : request.body.duration_seconds,
      timezone: request.body.timezone ?? current.timezone,
    }, context.config.timezone);
    context.database.db.update(maintenanceWindows).set({
      ...(request.body.name === undefined ? {} : { name: request.body.name }),
      ...(request.body.enabled === undefined && request.body.active === undefined ? {} : {
        enabled: request.body.active ?? request.body.enabled,
      }),
      ...(request.body.matcher === undefined && request.body.scope === undefined ? {} : {
        matcherJson: JSON.stringify(request.body.matcher ?? request.body.scope),
      }),
      kind: normalized.kind,
      startsAt: normalized.startsAt,
      endsAt: normalized.endsAt,
      cronExpression: normalized.cronExpression,
      durationSeconds: normalized.durationSeconds,
      timezone: normalized.timezone,
      ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
      updatedAt: new Date().toISOString(),
    }).where(eq(maintenanceWindows.id, current.id)).run();
    recordAudit(context.database, request, {
      action: 'maintenance_window.update', resourceType: 'maintenance_window', resourceId: current.id,
      metadata: { changed_fields: Object.keys(request.body) },
    });
    return success(request, maintenanceDto(requireMaintenance(context, current.id), siteNameMap(context)));
  });

  typed.delete('/api/v1/maintenance-windows/:id', {
    schema: { tags: ['operations'], summary: '永久删除维护窗口', params: idParamsSchema },
  }, async (request) => {
    context.database.sqlite.transaction(() => {
      const row = requireMaintenance(context, request.params.id);
      context.database.db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, row.id)).run();
      recordAudit(context.database, request, {
        action: 'maintenance_window.delete', resourceType: 'maintenance_window', resourceId: row.id,
      });
    }).immediate();
    return success(request, null);
  });

  typed.post('/api/v1/silences', {
    schema: { tags: ['operations'], summary: 'Create a temporary label silence', body: createSilenceSchema },
  }, async (request, reply) => {
    const id = createId('silence');
    const startsAt = request.body.starts_at
      ? normalizedTimestamp(request.body.starts_at)
      : new Date().toISOString();
    const endsAt = request.body.ends_at
      ? normalizedTimestamp(request.body.ends_at)
      : new Date(Date.parse(startsAt) + request.body.duration_seconds! * 1_000).toISOString();
    validateTimeRange(startsAt, endsAt);
    context.database.db.insert(silences).values({
      id,
      matcherJson: JSON.stringify(request.body.matcher),
      reason: request.body.reason,
      startsAt,
      endsAt,
      createdByAdminId: request.relayAdmin?.id ?? null,
    }).run();
    recordAudit(context.database, request, {
      action: 'silence.create', resourceType: 'silence', resourceId: id,
      metadata: { starts_at: startsAt, ends_at: endsAt },
    });
    reply.code(201);
    return success(request, silenceDto(
      requireSilence(context, id),
      siteNameMap(context),
      adminNameMap(context),
    ));
  });

  typed.get('/api/v1/silences', {
    schema: {
      tags: ['operations'],
      summary: 'List temporary silences',
      querystring: paginationSchema.extend({
        active: queryBooleanSchema.optional(),
        include_deleted: queryBooleanSchema.default(false),
      }),
    },
  }, async (request) => {
    const now = new Date().toISOString();
    const rows = context.database.db.select().from(silences)
      .orderBy(desc(silences.createdAt)).all()
      .filter((row) =>
        (request.query.include_deleted || row.deletedAt === null) &&
        (request.query.active === undefined || request.query.active === (
          row.deletedAt === null && row.startsAt <= now && row.endsAt > now
        ))
      );
    const offset = (request.query.page - 1) * request.query.page_size;
    const names = siteNameMap(context);
    const adminNames = adminNameMap(context);
    return success(request, {
      items: rows.slice(offset, offset + request.query.page_size)
        .map((row) => silenceDto(row, names, adminNames)),
      page: request.query.page,
      page_size: request.query.page_size,
      total: rows.length,
    });
  });

  typed.get('/api/v1/silences/:id', {
    schema: { tags: ['operations'], summary: 'Read a temporary silence', params: idParamsSchema },
  }, async (request) => success(
    request,
    silenceDto(
      requireSilence(context, request.params.id),
      siteNameMap(context),
      adminNameMap(context),
    ),
  ));

  typed.patch('/api/v1/silences/:id', {
    schema: {
      tags: ['operations'], summary: 'Update or end a temporary silence', params: idParamsSchema,
      body: patchSilenceSchema,
    },
  }, async (request) => {
    const current = requireSilence(context, request.params.id);
    if (current.deletedAt !== null) {
      throw new AppError('SILENCE_NOT_FOUND', '临时静默不存在', 404);
    }
    const startsAt = request.body.starts_at
      ? normalizedTimestamp(request.body.starts_at)
      : current.startsAt;
    let endsAt = request.body.ends_at
      ? normalizedTimestamp(request.body.ends_at)
      : current.endsAt;
    if (request.body.duration_seconds !== undefined) {
      endsAt = new Date(Date.parse(startsAt) + request.body.duration_seconds * 1_000).toISOString();
    }
    const ending = request.body.active === false;
    if (ending) endsAt = new Date().toISOString();
    if (!ending) validateTimeRange(startsAt, endsAt);

    context.database.db.update(silences).set({
      ...(request.body.matcher === undefined ? {} : { matcherJson: JSON.stringify(request.body.matcher) }),
      ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
      startsAt,
      endsAt,
    }).where(eq(silences.id, current.id)).run();
    recordAudit(context.database, request, {
      action: ending ? 'silence.end' : 'silence.update',
      resourceType: 'silence',
      resourceId: current.id,
      metadata: { changed_fields: Object.keys(request.body) },
    });
    return success(request, silenceDto(
      requireSilence(context, current.id),
      siteNameMap(context),
      adminNameMap(context),
    ));
  });

  typed.delete('/api/v1/silences/:id', {
    schema: { tags: ['operations'], summary: '永久删除临时静默', params: idParamsSchema },
  }, async (request) => {
    context.database.sqlite.transaction(() => {
      const row = requireSilence(context, request.params.id);
      context.database.db.delete(silences).where(eq(silences.id, row.id)).run();
      recordAudit(context.database, request, {
        action: 'silence.delete', resourceType: 'silence', resourceId: row.id,
      });
    }).immediate();
    return success(request, null);
  });

  typed.get('/api/v1/audit-logs', {
    schema: {
      tags: ['operations'],
      summary: '搜索已脱敏的审计记录',
      querystring: paginationSchema.extend({
        search: z.string().trim().max(200).optional(),
        result: z.enum(['success', 'failed']).optional(),
        from: rfc3339Schema.optional(),
        to: rfc3339Schema.optional(),
        action: z.string().trim().max(160).optional(),
        resource_type: z.string().trim().max(120).optional(),
        resource_id: z.string().trim().max(120).optional(),
        admin_id: z.string().trim().max(80).optional(),
        before: rfc3339Schema.optional(),
        after: rfc3339Schema.optional(),
      }),
    },
  }, async (request) => {
    const from = request.query.from ? normalizedTimestamp(request.query.from) : undefined;
    const to = request.query.to ? normalizedTimestamp(request.query.to) : undefined;
    const before = request.query.before ? normalizedTimestamp(request.query.before) : undefined;
    const after = request.query.after ? normalizedTimestamp(request.query.after) : undefined;
    if (from && to && from > to) {
      throw new AppError('INVALID_TIME_RANGE', '开始时间不能晚于结束时间', 400);
    }
    if (before && after && before <= after) {
      throw new AppError('INVALID_TIME_RANGE', '结束游标时间必须晚于开始游标时间', 400);
    }

    const conditions: SQL[] = [isNull(auditLogs.deletedAt)];
    if (request.query.action) conditions.push(eq(auditLogs.action, request.query.action));
    if (request.query.resource_type) conditions.push(eq(auditLogs.resourceType, request.query.resource_type));
    if (request.query.resource_id) conditions.push(eq(auditLogs.resourceId, request.query.resource_id));
    if (request.query.admin_id) conditions.push(eq(auditLogs.adminId, request.query.admin_id));
    if (from) conditions.push(gte(auditLogs.createdAt, from));
    if (to) conditions.push(lte(auditLogs.createdAt, to));
    if (before) conditions.push(lt(auditLogs.createdAt, before));
    if (after) conditions.push(gt(auditLogs.createdAt, after));
    if (request.query.search) {
      const pattern = escapedLikePattern(request.query.search);
      conditions.push(sql<boolean>`lower(
        coalesce(${auditLogs.action}, '') || ' ' ||
        coalesce(${auditLogs.resourceType}, '') || ' ' ||
        coalesce(${auditLogs.resourceId}, '') || ' ' ||
        coalesce(${auditLogs.requestId}, '') || ' ' ||
        coalesce(${auditLogs.adminId}, '') || ' ' ||
        coalesce(${auditLogs.metadataJson}, '')
      ) like ${pattern} escape '!'`);
    }
    if (request.query.result === 'failed') {
      conditions.push(sql<boolean>`(
        ${auditLogs.action} like '%failed' or
        ${auditLogs.action} like '%error' or
        ${auditLogs.action} like '%denied'
      )`);
    } else if (request.query.result === 'success') {
      conditions.push(sql<boolean>`not (
        ${auditLogs.action} like '%failed' or
        ${auditLogs.action} like '%error' or
        ${auditLogs.action} like '%denied'
      )`);
    }

    const where = and(...conditions)!;
    const offset = (request.query.page - 1) * request.query.page_size;
    const total = context.database.db.select({ value: count() }).from(auditLogs).where(where).get()?.value ?? 0;
    const rows = context.database.db.select().from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(request.query.page_size)
      .offset(offset)
      .all();
    return success(request, {
      items: rows.map(auditLogDto),
      page: request.query.page,
      page_size: request.query.page_size,
      total,
    });
  });

  typed.delete('/api/v1/audit-logs/:id', {
    schema: {
      tags: ['operations'],
      summary: '永久删除一条审计记录',
      params: idParamsSchema,
    },
  }, async (request) => {
    deleteAuditLogRecords(context, [request.params.id], false);
    return success(request, null);
  });

  typed.post('/api/v1/audit-logs/batch-delete', {
    schema: {
      tags: ['operations'],
      summary: '永久删除选中的审计记录',
      body: batchDeleteAuditLogsSchema,
    },
  }, async (request) => {
    const deletedCount = deleteAuditLogRecords(context, request.body.ids, true);
    return success(request, { deleted_count: deletedCount });
  });

  typed.post('/api/v1/audit-logs/delete-by-time', {
    schema: {
      tags: ['operations'],
      summary: '永久删除指定时间及以前的审计记录',
      body: deleteAuditLogsByTimeSchema,
    },
  }, async (request) => {
    const deletedCount = deleteAuditLogsBefore(context, normalizedTimestamp(request.body.before));
    return success(request, { deleted_count: deletedCount });
  });

  typed.delete('/api/v1/audit-logs', {
    schema: { tags: ['operations'], summary: '永久删除全部审计记录' },
  }, async (request) => {
    const deletedCount = deleteAllAuditLogs(context);
    return success(request, { deleted_count: deletedCount });
  });

  typed.post('/api/v1/system/backup', {
    schema: { tags: ['operations'], summary: 'Create an online SQLite backup in DATA_DIR/backups' },
  }, async (request, reply) => {
    const createdAt = new Date();
    const directory = join(context.config.dataDir, 'backups');
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const fileName = backupFileName(createdAt);
    const destination = join(directory, fileName);
    const metadata = await context.database.sqlite.backup(destination);
    const file = await stat(destination);
    recordAudit(context.database, request, {
      action: 'system.backup',
      resourceType: 'system_backup',
      resourceId: fileName,
      metadata: { file_name: fileName, size_bytes: file.size },
    });
    reply.code(201);
    return success(request, {
      file_name: fileName,
      backup_path: fileName,
      size_bytes: file.size,
      total_pages: metadata.totalPages,
      created_at: createdAt.toISOString(),
    });
  });
}
