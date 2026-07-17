import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { INCIDENT_STATES, SEVERITIES } from '../../shared/constants.js';
import {
  NOTIFICATION_EVENT_TYPES,
  SITE_NOTIFICATION_EVENT_TYPES,
  notificationEventTypesForRuleType,
} from '../../shared/notification-events.js';
import { decimalStringSchema, paginationSchema } from '../../shared/schemas.js';
import type { AppContext } from '../context.js';
import { success } from '../core/api-response.js';
import { recordAudit } from '../core/audit.js';
import { normalizeDecimal } from '../core/decimal.js';
import { AppError, errorMessage } from '../core/errors.js';
import { createId } from '../core/ids.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from '../core/idempotency.js';
import { redact, redactString } from '../core/redaction.js';
import { UnsafeUrlError } from '../core/ssrf.js';
import {
  createWebhookFetchContext,
  webhookOutboundErrorMessage,
} from '../core/webhook.js';
import {
  incidents,
  notificationChannels,
  notificationDeliveries,
  notificationRuleRevisions,
  notificationRules,
  outboxMessages,
  silences,
  sites,
} from '../db/index.js';
import { isSystemEventRuleId } from '../services/system-event-rule.js';
import {
  ENCRYPTED_HEADERS_SECRET_TYPE,
  MASKED_WEBHOOK_HEADER_VALUE,
  prepareWebhookRequest,
  redactWebhookSecrets,
  WebhookRequestConfigurationError,
} from '../services/webhook-request.js';

const CHANNEL_SECRET_AAD_TYPE = 'notification_channel_secret';
const MAX_TEST_RESPONSE_CHARACTERS = 8_192;

const idParamsSchema = z.object({ id: z.string().min(1).max(80) });
const MAX_INCIDENT_BATCH_DELETE = 100;
const INCIDENT_DELETE_SQL_CHUNK_SIZE = 400;
const incidentIdSchema = z.string().trim().min(1).max(80);
const batchDeleteIncidentsSchema = z.object({
  ids: z.array(incidentIdSchema).min(1).max(MAX_INCIDENT_BATCH_DELETE),
}).refine(({ ids }) => new Set(ids).size === ids.length, {
  path: ['ids'],
  message: '事件 ID 不能重复',
});
const deleteIncidentsByTimeSchema = z.object({
  before: z.string().datetime({ offset: true }).max(64),
});
const jsonObjectSchema = z.record(z.string().min(1).max(128), z.json());
const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1'),
]);
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reservedWebhookHeaders = new Set([
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'trailer',
  'upgrade',
  'expect',
  'te',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-monitor-event-id',
  'x-monitor-timestamp',
  'x-monitor-signature',
  'idempotency-key',
]);

const configuredHeadersSchema = z
  .record(
    z.string().min(1).max(128).regex(headerNamePattern, 'Header 名称格式无效'),
    z.string().max(4_096).refine((value) => !/[\r\n]/.test(value), 'Header 值不能包含换行'),
  )
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > 64) {
      context.addIssue({ code: 'custom', message: '额外 Header 最多配置 64 项' });
    }
    const normalizedNames = new Set<string>();
    for (const name of Object.keys(headers)) {
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) {
        context.addIssue({ code: 'custom', path: [name], message: 'Header 名称不能只通过大小写重复' });
      }
      normalizedNames.add(normalizedName);
      if (reservedWebhookHeaders.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: '该 Header 由 Relay Monitor 管理，不能自定义',
        });
      }
    }
  });

const channelFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.literal('webhook').default('webhook'),
  enabled: z.boolean().default(true),
  url: z.string().url().max(2_048),
  method: z.literal('POST').default('POST'),
  timeout_seconds: z.number().int().min(1).max(120).default(10),
  headers: configuredHeadersSchema.default({}),
  body_mode: z.enum(['json', 'form_data', 'custom']).default('json'),
  body_template: z.string().max(64 * 1_024).nullable().optional(),
  retry_delays_seconds: z.array(z.number().int().min(1).max(7 * 24 * 60 * 60)).max(20).default([60, 300, 900]),
  max_response_bytes: z.number().int().min(1_024).max(2 * 1_024 * 1_024).default(65_536),
});

const createChannelSchema = channelFieldsSchema.superRefine((input, context) => {
  if (input.body_mode === 'custom' && !input.body_template?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['body_template'],
      message: '自定义内容模式必须填写请求体模板',
    });
  }
});

const patchChannelSchema = channelFieldsSchema.partial().extend({
  type: z.literal('webhook').optional(),
  enabled: z.boolean().optional(),
  method: z.literal('POST').optional(),
  timeout_seconds: z.number().int().min(1).max(120).optional(),
  headers: configuredHeadersSchema.optional(),
  body_mode: z.enum(['json', 'form_data', 'custom']).optional(),
  body_template: z.string().max(64 * 1_024).nullable().optional(),
  retry_delays_seconds: z.array(z.number().int().min(1).max(7 * 24 * 60 * 60)).max(20).optional(),
  max_response_bytes: z.number().int().min(1_024).max(2 * 1_024 * 1_024).optional(),
}).refine((input) => Object.keys(input).length > 0, '至少填写一个要修改的字段');

const directionsSchema = z.array(z.enum(['up', 'down'])).min(1).max(2);
const conditionOperatorSchema = z.enum([
  'lt', '<', 'lte', '<=', 'gt', '>', 'gte', '>=', 'eq', '=', '==', 'ne', '!=',
]);
const scopeSchema = jsonObjectSchema;

const ruleRevisionFieldsSchema = z.object({
  scope: scopeSchema.default({}),
  event_types: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).min(1)
    .max(NOTIFICATION_EVENT_TYPES.length).optional(),
  directions: directionsSchema.optional(),
  operator: conditionOperatorSchema.optional(),
  status: z.string().trim().min(1).max(80).optional(),
  statuses: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
  balance_key: z.string().trim().min(1).max(160).nullable().optional(),
  threshold: decimalStringSchema.nullable().optional(),
  recovery_threshold: decimalStringSchema.nullable().optional(),
  minimum_change: decimalStringSchema.nullable().optional(),
  recovery_confirm_count: z.number().int().min(1).max(10_000).default(2),
  digest_window_seconds: z.number().int().min(0).max(24 * 60 * 60).default(60),
  cooldown_seconds: z.number().int().min(0).max(365 * 24 * 60 * 60).default(300),
  repeat_interval_seconds: z.number().int().min(0).max(365 * 24 * 60 * 60).default(0),
  max_repeats: z.number().int().min(0).max(10_000).default(0),
  send_recovery: z.boolean().default(true),
  channel_ids: z.array(z.string().min(1).max(80)).max(100).default([]),
});

const createRuleSchema = ruleRevisionFieldsSchema.extend({
  name: z.string().trim().min(1).max(120),
  type: z.literal('monitor_events').default('monitor_events'),
  enabled: z.boolean().default(true),
  severity: z.enum(SEVERITIES).default('warning'),
});

const patchRuleSchema = createRuleSchema.partial().extend({
  scope: scopeSchema.optional(),
  recovery_confirm_count: z.number().int().min(1).max(10_000).optional(),
  digest_window_seconds: z.number().int().min(0).max(24 * 60 * 60).optional(),
  cooldown_seconds: z.number().int().min(0).max(365 * 24 * 60 * 60).optional(),
  repeat_interval_seconds: z.number().int().min(0).max(365 * 24 * 60 * 60).optional(),
  max_repeats: z.number().int().min(0).max(10_000).optional(),
  send_recovery: z.boolean().optional(),
  channel_ids: z.array(z.string().min(1).max(80)).max(100).optional(),
  enabled: z.boolean().optional(),
  severity: z.enum(SEVERITIES).optional(),
})
  .refine((input) => Object.keys(input).length > 0, '至少填写一个要修改的字段');

const incidentSilenceSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
  duration_seconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
  expires_at: z.string().datetime({ offset: true }).max(64).optional(),
}).superRefine((input, context) => {
  if (input.duration_seconds !== undefined && input.expires_at !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['expires_at'],
      message: '持续时间和到期时间只能填写一项',
    });
  }
});

type ChannelRow = typeof notificationChannels.$inferSelect;
type RuleRow = typeof notificationRules.$inferSelect;
type RuleRevisionRow = typeof notificationRuleRevisions.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;
type DeliveryRow = typeof notificationDeliveries.$inferSelect;
type OutboxRow = typeof outboxMessages.$inferSelect;

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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function objectLabel(value: Record<string, unknown>, fallback: string): string {
  if (typeof value.label === 'string' && value.label.trim()) return value.label;
  const parts = Object.entries(value).map(([key, item]) => {
    if (Array.isArray(item)) return `${key}=${item.join(', ')}`;
    if (item !== null && typeof item !== 'object') return `${key}=${String(item)}`;
    return key;
  });
  return parts.length > 0 ? parts.join(' AND ') : fallback;
}

function allowedCidrs(context: AppContext): string[] {
  return uniqueStrings(context.config.outboundAllowedCidrs);
}

async function validateChannelUrl(
  context: AppContext,
  url: string,
  timeoutSeconds: number,
  maxResponseBytes: number,
): Promise<string> {
  let outbound: Awaited<ReturnType<typeof createWebhookFetchContext>> | undefined;
  try {
    outbound = await createWebhookFetchContext(url, {
      isProduction: context.config.isProduction,
      allowedCidrs: allowedCidrs(context),
      connectTimeoutMs: timeoutSeconds * 1_000,
      maxResponseBytes,
    });
    return outbound.baseUrl;
  } catch (error) {
    throw new AppError('UNSAFE_OUTBOUND_URL', redactString(webhookOutboundErrorMessage(error)), 400);
  } finally {
    await outbound?.close();
  }
}

function channelDto(context: AppContext, row: ChannelRow) {
  const headers = parseObject(row.headersJson);
  const stringHeaders = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const latestDelivery = context.database.db
    .select({ delivery: notificationDeliveries })
    .from(notificationDeliveries)
    .innerJoin(outboxMessages, eq(notificationDeliveries.outboxMessageId, outboxMessages.id))
    .where(eq(outboxMessages.channelId, row.id))
    .orderBy(desc(notificationDeliveries.createdAt))
    .get()?.delivery;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    url: row.url,
    method: row.method,
    timeout_seconds: row.timeoutSeconds,
    headers: maskedHeaderRecord(stringHeaders),
    has_headers: Object.keys(stringHeaders).length > 0,
    body_mode: row.bodyMode,
    body_template: row.bodyTemplate ? redactString(row.bodyTemplate) : null,
    legacy_security: row.secretType !== null && row.secretType !== ENCRYPTED_HEADERS_SECRET_TYPE,
    retry_delays_seconds: parseObjectArray(row.retryDelaysJson),
    max_response_bytes: row.maxResponseBytes,
    last_delivery_status: latestDelivery
      ? latestDelivery.succeeded ? 'success' : 'failed'
      : 'never',
    last_delivery_at: latestDelivery?.createdAt ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function parseObjectArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isSafeInteger(item) && item >= 0)
      : [];
  } catch {
    return [];
  }
}

function requireChannel(context: AppContext, id: string): ChannelRow {
  const row = context.database.db.select().from(notificationChannels)
    .where(and(eq(notificationChannels.id, id), isNull(notificationChannels.deletedAt))).get();
  if (!row) throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND', '通知渠道不存在', 404);
  return row;
}

function requireChannels(context: AppContext, channelIds: readonly string[]): string[] {
  const unique = uniqueStrings(channelIds);
  if (unique.length === 0) return unique;
  const found = context.database.db.select({ id: notificationChannels.id })
    .from(notificationChannels).where(and(
      inArray(notificationChannels.id, unique),
      isNull(notificationChannels.deletedAt),
    )).all();
  const foundIds = new Set(found.map((row) => row.id));
  const missing = unique.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND', '一个或多个通知渠道不存在', 400, {
      channel_ids: missing,
    });
  }
  return unique;
}

function conditionFromInput(input: {
  event_types?: readonly string[] | undefined;
  directions?: readonly ('up' | 'down')[] | undefined;
  operator?: string | undefined;
  status?: string | undefined;
  statuses?: readonly string[] | undefined;
  balance_key?: string | null | undefined;
  threshold?: string | null | undefined;
  recovery_threshold?: string | null | undefined;
  minimum_change?: string | null | undefined;
}): Record<string, unknown> {
  return {
    ...(input.event_types === undefined ? {} : { event_types: uniqueStrings(input.event_types) }),
    ...(input.directions === undefined ? {} : { directions: input.directions }),
    ...(input.operator === undefined ? {} : { operator: input.operator }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
    ...(input.balance_key === undefined ? {} : { balance_key: input.balance_key }),
    ...(input.threshold === undefined ? {} : {
      threshold: input.threshold === null ? null : normalizeDecimal(input.threshold),
    }),
    ...(input.recovery_threshold === undefined ? {} : {
      recovery_threshold: input.recovery_threshold === null
        ? null
        : normalizeDecimal(input.recovery_threshold),
    }),
    ...(input.minimum_change === undefined ? {} : {
      minimum_change: input.minimum_change === null ? null : normalizeDecimal(input.minimum_change),
    }),
  };
}

function validateRuleCondition(type: string, condition: Record<string, unknown>): void {
  if (condition.event_types === undefined) {
    condition.event_types = notificationEventTypesForRuleType(type);
  }
  const eventTypes = Array.isArray(condition.event_types)
    ? condition.event_types.filter((item): item is string => typeof item === 'string')
    : [];
  if (eventTypes.includes('probe.recovered') && !eventTypes.includes('probe.failed')) {
    throw new AppError('INVALID_RULE_CONDITION', '选择“实测恢复”时必须在同一规则中选择“实测失败”', 400);
  }
  const siteFailureTypes = SITE_NOTIFICATION_EVENT_TYPES.filter((eventType) => eventType !== 'site.recovered');
  if (eventTypes.includes('site.recovered') && !siteFailureTypes.some((eventType) => eventTypes.includes(eventType))) {
    throw new AppError('INVALID_RULE_CONDITION', '选择“恢复上线”时必须在同一规则中选择至少一种站点故障', 400);
  }
  if ((type === 'rate_changed' || type === 'monitor_events' && eventTypes.includes('rate.changed'))
    && condition.directions === undefined) {
    condition.directions = ['up', 'down'];
  }
  if (type === 'rate_threshold' && typeof condition.threshold !== 'string') {
    throw new AppError('INVALID_RULE_CONDITION', '倍率阈值规则必须填写有效的十进制阈值', 400);
  }
  if (type !== 'balance_threshold' && type !== 'balance_low') return;
  if (typeof condition.balance_key !== 'string' || condition.balance_key.length === 0) {
    throw new AppError('INVALID_RULE_CONDITION', '余额阈值规则必须填写余额键', 400);
  }
  if (typeof condition.threshold !== 'string') {
    throw new AppError('INVALID_RULE_CONDITION', '余额阈值规则必须填写有效的十进制阈值', 400);
  }
  condition.threshold = normalizeDecimal(condition.threshold);
  if (condition.recovery_threshold !== undefined && condition.recovery_threshold !== null) {
    if (typeof condition.recovery_threshold !== 'string') {
      throw new AppError('INVALID_RULE_CONDITION', '恢复阈值必须是有效的十进制数', 400);
    }
    condition.recovery_threshold = normalizeDecimal(condition.recovery_threshold);
  }
}

function revisionDto(row: RuleRevisionRow) {
  const condition = parseObject(row.conditionJson);
  return {
    id: row.id,
    revision_number: row.revisionNumber,
    scope: parseObject(row.scopeJson),
    condition,
    event_types: Array.isArray(condition.event_types)
      ? condition.event_types.filter((item): item is string => typeof item === 'string')
      : [],
    recovery_confirm_count: row.recoveryConfirmCount,
    digest_window_seconds: row.digestWindowSeconds,
    cooldown_seconds: row.cooldownSeconds,
    repeat_interval_seconds: row.repeatIntervalSeconds,
    max_repeats: row.maxRepeats,
    send_recovery: row.sendRecovery,
    channel_ids: parseStringArray(row.channelIdsJson),
    created_by_admin_id: row.createdByAdminId,
    created_at: row.createdAt,
  };
}

function ruleDto(row: RuleRow, revision: RuleRevisionRow) {
  const revisionData = revisionDto(revision);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    severity: row.severity,
    current_revision: revisionData,
    scope_label: objectLabel(revisionData.scope, '全部站点'),
    recovery_confirm_count: revision.recoveryConfirmCount,
    repeat_interval_seconds: revision.repeatIntervalSeconds,
    max_repeats: revision.maxRepeats,
    channel_ids: revisionData.channel_ids,
    event_types: revisionData.event_types.length > 0
      ? revisionData.event_types
      : notificationEventTypesForRuleType(row.type),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function requireRule(context: AppContext, id: string): { rule: RuleRow; revision: RuleRevisionRow } {
  if (isSystemEventRuleId(id)) {
    throw new AppError('NOTIFICATION_RULE_NOT_FOUND', '告警规则不存在', 404);
  }
  const rule = context.database.db.select().from(notificationRules)
    .where(and(eq(notificationRules.id, id), isNull(notificationRules.deletedAt))).get();
  if (!rule) throw new AppError('NOTIFICATION_RULE_NOT_FOUND', '告警规则不存在', 404);
  const revision = rule.currentRevisionId
    ? context.database.db.select().from(notificationRuleRevisions)
      .where(and(
        eq(notificationRuleRevisions.id, rule.currentRevisionId),
        eq(notificationRuleRevisions.ruleId, rule.id),
      )).get()
    : undefined;
  if (!revision) {
    throw new AppError('NOTIFICATION_RULE_REVISION_MISSING', '告警规则缺少当前修订，请重新创建规则', 409);
  }
  return { rule, revision };
}

function incidentDto(context: AppContext, row: IncidentRow) {
  const siteName = row.siteId
    ? context.database.db.select({ name: sites.name }).from(sites).where(eq(sites.id, row.siteId)).get()?.name
    : undefined;
  return {
    id: row.id,
    title: row.summary,
    rule_revision_id: row.ruleRevisionId,
    site_id: row.siteId,
    site_name: siteName ?? '全局事件',
    resource_key: row.resourceKey,
    event_type: row.eventType,
    fingerprint: row.fingerprint,
    state: row.state === 'pending' || row.state === 'acknowledged' ? 'firing' : row.state,
    severity: row.severity,
    summary: row.summary,
    details: redact(parseObject(row.detailsJson)),
    trigger_count: row.triggerCount,
    occurrence_count: row.triggerCount,
    recovery_count: row.recoveryCount,
    repeat_count: row.repeatCount,
    first_observed_at: row.firstObservedAt,
    started_at: row.firstObservedAt,
    fired_at: row.firedAt,
    resolved_at: row.resolvedAt,
    last_observed_at: row.lastObservedAt,
    last_notified_at: row.lastNotifiedAt,
    suppressed_by_incident_id: row.suppressedByIncidentId,
    suppression_reason: row.suppressionReason,
    suppressed_by: row.suppressionReason ?? row.suppressedByIncidentId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
  };
}

function requireIncident(context: AppContext, id: string): IncidentRow {
  const row = context.database.db.select().from(incidents).where(and(
    eq(incidents.id, id),
    isNull(incidents.deletedAt),
  )).get();
  if (!row) throw new AppError('INCIDENT_NOT_FOUND', '事件不存在', 404);
  return row;
}

function incidentDeleteClosure(context: AppContext, initialIds: readonly string[]): string[] {
  const selected = new Set(initialIds);
  const dependencies = context.database.db.select({
    id: incidents.id,
    rootId: incidents.suppressedByIncidentId,
  }).from(incidents).all();
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of dependencies) {
      if (!dependency.rootId || !selected.has(dependency.rootId) || selected.has(dependency.id)) continue;
      selected.add(dependency.id);
      changed = true;
    }
  }
  return [...selected];
}

function incidentDeleteChunks<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += INCIDENT_DELETE_SQL_CHUNK_SIZE) {
    chunks.push(values.slice(offset, offset + INCIDENT_DELETE_SQL_CHUNK_SIZE));
  }
  return chunks;
}

function deleteIncidentRecords(
  context: AppContext,
  requestedIds: readonly string[],
  requireExact: boolean,
): { deletedCount: number; deletedIds: string[] } {
  const operation = (): { deletedCount: number; deletedIds: string[] } => {
    const uniqueRequestedIds = [...new Set(requestedIds)];
    const requested = incidentDeleteChunks(uniqueRequestedIds).flatMap((ids) =>
      context.database.db.select({ id: incidents.id }).from(incidents)
        .where(inArray(incidents.id, ids)).all()
    );
    if (requireExact && requested.length !== requestedIds.length) {
      throw new AppError(
        requestedIds.length === 1 ? 'INCIDENT_NOT_FOUND' : 'INCIDENT_BATCH_CONFLICT',
        requestedIds.length === 1 ? '事件不存在' : '部分事件不存在，请刷新后重试',
        requestedIds.length === 1 ? 404 : 409,
      );
    }
    if (requested.length === 0) return { deletedCount: 0, deletedIds: [] };

    const deleteIds = incidentDeleteClosure(context, requested.map(({ id }) => id));
    const deleteChunks = incidentDeleteChunks(deleteIds);
    const sending = deleteChunks.some((ids) => context.database.db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(and(
        inArray(outboxMessages.incidentId, ids),
        eq(outboxMessages.state, 'sending'),
      ))
      .get() !== undefined);
    if (sending) {
      throw new AppError(
        'INCIDENT_DELIVERY_IN_PROGRESS',
        '所选事件仍有通知正在发送，请稍后重试删除',
        409,
      );
    }

    for (const ids of deleteChunks) {
      context.database.db.update(incidents).set({ suppressedByIncidentId: null })
        .where(inArray(incidents.suppressedByIncidentId, ids)).run();
    }
    let deletedCount = 0;
    for (const ids of deleteChunks) {
      deletedCount += context.database.db.delete(incidents)
        .where(inArray(incidents.id, ids)).run().changes;
    }
    return { deletedCount, deletedIds: deleteIds };
  };
  return context.database.sqlite.inTransaction
    ? operation()
    : context.database.sqlite.transaction(operation).immediate();
}

function deliveryDto(context: AppContext, delivery: DeliveryRow, outbox: OutboxRow | undefined) {
  const channelName = outbox
    ? context.database.db.select({ name: notificationChannels.name }).from(notificationChannels)
      .where(eq(notificationChannels.id, outbox.channelId)).get()?.name
    : undefined;
  const deliveryStatus = outbox?.state === 'sent'
    ? 'sent'
    : outbox?.state === 'dead'
      ? 'dead'
      : 'retry';
  return {
    id: delivery.id,
    outbox_message_id: delivery.outboxMessageId,
    incident_id: outbox?.incidentId ?? null,
    channel_id: outbox?.channelId ?? null,
    channel_name: channelName ?? '未知渠道',
    event_id: outbox?.eventId ?? null,
    idempotency_key: outbox?.idempotencyKey ?? null,
    outbox_state: outbox?.state ?? null,
    status: deliveryStatus,
    attempt_number: delivery.attemptNumber,
    attempt: delivery.attemptNumber,
    request_timestamp: delivery.requestTimestamp,
    response_status: delivery.responseStatus,
    http_status: delivery.responseStatus,
    duration_ms: delivery.durationMs,
    response_body_truncated: delivery.responseBodyTruncated
      ? redactString(delivery.responseBodyTruncated)
      : null,
    error_code: delivery.errorCode,
    error_message: delivery.errorMessage ? redactString(delivery.errorMessage) : null,
    succeeded: delivery.succeeded,
    created_at: delivery.createdAt,
  };
}

function secretEnvelope(row: ChannelRow) {
  if (
    row.secretCiphertext === null ||
    row.secretNonce === null ||
    row.secretAuthTag === null ||
    row.secretKeyVersion === null
  ) return undefined;
  return {
    ciphertext: row.secretCiphertext,
    nonce: row.secretNonce,
    authTag: row.secretAuthTag,
    keyVersion: row.secretKeyVersion,
  };
}

function maskedHeaderRecord(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((name) => [name, MASKED_WEBHOOK_HEADER_VALUE]));
}

function decryptEncryptedHeaders(context: AppContext, row: ChannelRow): Record<string, string> {
  if (row.secretType !== ENCRYPTED_HEADERS_SECRET_TYPE) return {};
  const envelope = secretEnvelope(row);
  if (!envelope) {
    throw new AppError('WEBHOOK_HEADERS_MISSING', '通知渠道的加密 Header 配置不完整', 409);
  }
  const plaintext = context.vault.decryptCredential(row.id, CHANNEL_SECRET_AAD_TYPE, envelope);
  try {
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) throw new Error();
    return Object.fromEntries(entries);
  } catch {
    throw new AppError('WEBHOOK_HEADERS_INVALID', '通知渠道的加密 Header 配置无法读取', 409);
  } finally {
    plaintext.fill(0);
  }
}

function resolveHeaderUpdate(
  context: AppContext,
  row: ChannelRow,
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  if (row.secretType !== null && row.secretType !== ENCRYPTED_HEADERS_SECRET_TYPE) {
    throw new AppError(
      'LEGACY_WEBHOOK_SECURITY_READ_ONLY',
      '该渠道仍使用旧版签名或认证配置；请新建渠道后再配置额外 Header',
      409,
    );
  }
  const existing = decryptEncryptedHeaders(context, row);
  return Object.fromEntries(Object.entries(input).map(([name, value]) => {
    if (value !== MASKED_WEBHOOK_HEADER_VALUE) return [name, value];
    if (existing[name] === undefined) {
      throw new AppError(
        'WEBHOOK_HEADER_VALUE_REQUIRED',
        `Header ${name} 需要填写新值`,
        400,
      );
    }
    return [name, existing[name]];
  }));
}

export async function registerNotificationRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/api/v1/notification-channels', {
    schema: {
      tags: ['notifications'],
      summary: 'Create a secure webhook notification channel',
      body: createChannelSchema,
    },
  }, async (request, reply) => {
    const id = createId('channel');
    const normalizedUrl = await validateChannelUrl(
      context,
      request.body.url,
      request.body.timeout_seconds,
      request.body.max_response_bytes,
    );
    const hasHeaders = Object.keys(request.body.headers).length > 0;
    const encrypted = !hasHeaders
      ? undefined
      : context.vault.encryptCredential(
        id,
        CHANNEL_SECRET_AAD_TYPE,
        JSON.stringify(request.body.headers),
      );
    context.database.sqlite.transaction(() => {
      context.database.db.insert(notificationChannels).values({
        id,
        name: request.body.name,
        type: request.body.type,
        enabled: request.body.enabled,
        url: normalizedUrl,
        method: request.body.method,
        timeoutSeconds: request.body.timeout_seconds,
        headersJson: JSON.stringify(maskedHeaderRecord(request.body.headers)),
        bodyMode: request.body.body_mode,
        bodyTemplate: request.body.body_mode === 'custom' ? request.body.body_template ?? null : null,
        secretType: hasHeaders ? ENCRYPTED_HEADERS_SECRET_TYPE : null,
        secretCiphertext: encrypted?.ciphertext ?? null,
        secretNonce: encrypted?.nonce ?? null,
        secretAuthTag: encrypted?.authTag ?? null,
        secretKeyVersion: encrypted?.keyVersion ?? null,
        allowedCidrsJson: '[]',
        retryDelaysJson: JSON.stringify(request.body.retry_delays_seconds),
        maxResponseBytes: request.body.max_response_bytes,
      }).run();
      recordAudit(context.database, request, {
        action: 'notification_channel.create',
        resourceType: 'notification_channel',
        resourceId: id,
        metadata: {
          type: 'webhook',
          body_mode: request.body.body_mode,
          has_headers: hasHeaders,
        },
      });
    }).immediate();
    reply.code(201);
    return success(request, channelDto(context, requireChannel(context, id)));
  });

  typed.get('/api/v1/notification-channels', {
    schema: { tags: ['notifications'], summary: 'List notification channels' },
  }, async (request) => {
    const rows = context.database.db.select().from(notificationChannels)
      .where(isNull(notificationChannels.deletedAt))
      .orderBy(asc(notificationChannels.name)).all();
    return success(request, rows.map((row) => channelDto(context, row)));
  });

  typed.get('/api/v1/notification-channels/:id', {
    schema: { tags: ['notifications'], summary: 'Read a notification channel', params: idParamsSchema },
  }, async (request) => success(request, channelDto(context, requireChannel(context, request.params.id))));

  typed.patch('/api/v1/notification-channels/:id', {
    schema: {
      tags: ['notifications'],
      summary: 'Update a notification channel',
      params: idParamsSchema,
      body: patchChannelSchema,
    },
  }, async (request) => {
    const current = requireChannel(context, request.params.id);
    const nextTimeout = request.body.timeout_seconds ?? current.timeoutSeconds;
    const nextMaxResponseBytes = request.body.max_response_bytes ?? current.maxResponseBytes;
    let nextUrl: string | undefined;
    if (request.body.url !== undefined) {
      nextUrl = await validateChannelUrl(
        context,
        request.body.url ?? current.url,
        nextTimeout,
        nextMaxResponseBytes,
      );
    }

    const nextBodyMode = request.body.body_mode ?? current.bodyMode;
    const nextBodyTemplate = request.body.body_template === undefined
      ? current.bodyTemplate
      : request.body.body_template;
    if (nextBodyMode === 'custom' && !nextBodyTemplate?.trim()) {
      throw new AppError(
        'WEBHOOK_BODY_TEMPLATE_REQUIRED',
        '自定义内容模式必须填写请求体模板',
        400,
      );
    }
    if (current.secretType?.split('+').includes('hmac_sha256') && nextBodyMode !== 'json') {
      throw new AppError(
        'LEGACY_WEBHOOK_SECURITY_READ_ONLY',
        '旧版签名渠道只能继续使用 JSON 请求体；请新建渠道后使用其他请求体模式',
        409,
      );
    }

    const resolvedHeaders = request.body.headers === undefined
      ? undefined
      : resolveHeaderUpdate(context, current, request.body.headers);
    const encrypted = resolvedHeaders && Object.keys(resolvedHeaders).length > 0
      ? context.vault.encryptCredential(
        current.id,
        CHANNEL_SECRET_AAD_TYPE,
        JSON.stringify(resolvedHeaders),
      )
      : undefined;

    const currentUpdatedAt = Date.parse(current.updatedAt);
    const now = new Date(Math.max(
      Date.now(),
      Number.isFinite(currentUpdatedAt) ? currentUpdatedAt + 1 : Date.now(),
    ));

    context.database.sqlite.transaction(() => {
      const updated = context.database.db.update(notificationChannels).set({
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
        ...(nextUrl === undefined ? {} : { url: nextUrl }),
        ...(request.body.method === undefined ? {} : { method: request.body.method }),
        ...(request.body.timeout_seconds === undefined ? {} : { timeoutSeconds: request.body.timeout_seconds }),
        ...(resolvedHeaders === undefined ? {} : {
          headersJson: JSON.stringify(maskedHeaderRecord(resolvedHeaders)),
        }),
        ...(request.body.body_mode === undefined ? {} : { bodyMode: request.body.body_mode }),
        ...(request.body.body_mode === undefined && request.body.body_template === undefined ? {} : {
          bodyTemplate: nextBodyMode === 'custom' ? nextBodyTemplate : null,
        }),
        ...(request.body.retry_delays_seconds === undefined ? {} : {
          retryDelaysJson: JSON.stringify(request.body.retry_delays_seconds),
        }),
        ...(request.body.max_response_bytes === undefined ? {} : {
          maxResponseBytes: request.body.max_response_bytes,
        }),
        ...(resolvedHeaders === undefined ? {} : {
          secretType: Object.keys(resolvedHeaders).length > 0
            ? ENCRYPTED_HEADERS_SECRET_TYPE
            : null,
        }),
        ...(resolvedHeaders !== undefined && !encrypted ? {
          secretCiphertext: null,
          secretNonce: null,
          secretAuthTag: null,
          secretKeyVersion: null,
          previousSecretCiphertext: null,
          previousSecretNonce: null,
          previousSecretAuthTag: null,
          previousSecretKeyVersion: null,
          previousSecretValidUntil: null,
        } : resolvedHeaders !== undefined && encrypted ? {
          secretCiphertext: encrypted.ciphertext,
          secretNonce: encrypted.nonce,
          secretAuthTag: encrypted.authTag,
          secretKeyVersion: encrypted.keyVersion,
          previousSecretCiphertext: null,
          previousSecretNonce: null,
          previousSecretAuthTag: null,
          previousSecretKeyVersion: null,
          previousSecretValidUntil: null,
        } : {}),
        updatedAt: now.toISOString(),
      }).where(and(
        eq(notificationChannels.id, current.id),
        eq(notificationChannels.updatedAt, current.updatedAt),
        isNull(notificationChannels.deletedAt),
      )).run();
      if (updated.changes !== 1) {
        throw new AppError(
          'NOTIFICATION_CHANNEL_UPDATE_CONFLICT',
          '通知渠道已被其他请求修改，请刷新后重试',
          409,
        );
      }
      recordAudit(context.database, request, {
        action: 'notification_channel.update',
        resourceType: 'notification_channel',
        resourceId: current.id,
        metadata: {
          changed_fields: Object.keys(request.body).filter((field) => field !== 'headers'),
          headers_changed: resolvedHeaders !== undefined,
        },
      });
    }).immediate();
    return success(request, channelDto(context, requireChannel(context, current.id)));
  });

  typed.delete('/api/v1/notification-channels/:id', {
    schema: { tags: ['notifications'], summary: '删除未被规则引用的通知渠道', params: idParamsSchema },
  }, async (request) => {
    context.database.sqlite.transaction(() => {
      const channel = requireChannel(context, request.params.id);
      const ruleIds = context.database.db.select({
        id: notificationRules.id,
        channelIdsJson: notificationRuleRevisions.channelIdsJson,
      }).from(notificationRules).innerJoin(
        notificationRuleRevisions,
        and(
          eq(notificationRules.currentRevisionId, notificationRuleRevisions.id),
          eq(notificationRuleRevisions.ruleId, notificationRules.id),
        ),
      ).where(isNull(notificationRules.deletedAt)).all()
        .filter((rule) => parseStringArray(rule.channelIdsJson).includes(channel.id))
        .map((rule) => rule.id);
      if (ruleIds.length > 0) {
        throw new AppError(
          'NOTIFICATION_CHANNEL_IN_USE',
          'Notification channel is still referenced by a rule',
          409,
          { notification_rule_ids: ruleIds },
        );
      }

      const sending = context.database.db.select({ id: outboxMessages.id }).from(outboxMessages)
        .where(and(
          eq(outboxMessages.channelId, channel.id),
          eq(outboxMessages.state, 'sending'),
        )).get();
      if (sending) {
        throw new AppError(
          'NOTIFICATION_CHANNEL_DELIVERY_IN_PROGRESS',
          '通知渠道仍有投递正在发送，请等待发送结束后再删除',
          409,
        );
      }

      const cancelled = context.database.db.select({ id: outboxMessages.id }).from(outboxMessages)
        .where(and(
          eq(outboxMessages.channelId, channel.id),
          inArray(outboxMessages.state, ['pending', 'retry']),
        )).all();
      const now = new Date().toISOString();
      if (cancelled.length > 0) {
        context.database.db.update(outboxMessages).set({
          state: 'dead',
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: 'NOTIFICATION_CHANNEL_DELETED',
          lastErrorMessage: '通知渠道已删除，投递已取消',
          updatedAt: now,
        }).where(inArray(outboxMessages.id, cancelled.map(({ id }) => id))).run();
      }
      context.database.db.update(notificationChannels).set({
        enabled: false,
        url: 'https://deleted.invalid/',
        headersJson: '{}',
        bodyTemplate: null,
        secretType: null,
        secretCiphertext: null,
        secretNonce: null,
        secretAuthTag: null,
        secretKeyVersion: null,
        previousSecretCiphertext: null,
        previousSecretNonce: null,
        previousSecretAuthTag: null,
        previousSecretKeyVersion: null,
        previousSecretValidUntil: null,
        allowedCidrsJson: '[]',
        deletedAt: now,
        updatedAt: now,
      }).where(eq(notificationChannels.id, channel.id)).run();
      recordAudit(context.database, request, {
        action: 'notification_channel.soft_delete',
        resourceType: 'notification_channel',
        resourceId: channel.id,
        metadata: { cancelled_delivery_count: cancelled.length },
      });
    }).immediate();
    return success(request, null);
  });

  typed.post('/api/v1/notification-channels/:id/test', {
    schema: { tags: ['notifications'], summary: 'Safely send a webhook test', params: idParamsSchema },
  }, async (request) => {
    const channel = requireChannel(context, request.params.id);
    let outbound: Awaited<ReturnType<typeof createWebhookFetchContext>> | undefined;
    let prepared: Awaited<ReturnType<typeof prepareWebhookRequest>> | undefined;
    const startedAt = Date.now();
    let result: {
      succeeded: boolean;
      response_status: number | null;
      duration_ms: number;
      response_body_truncated: string | null;
      error_code: string | null;
      error_message: string | null;
    };
    try {
      const eventId = createId('event');
      const sentAt = new Date().toISOString();
      const payloadJson = JSON.stringify({
        schema_version: '1.0',
        event: 'webhook.test',
        event_id: eventId,
        notification_kind: 'test',
        severity: 'info',
        incident: {
          id: 'test',
          state: 'test',
          resource_key: 'webhook',
          summary: 'Webhook 测试消息',
        },
        rule: { id: 'test', name: '渠道测试', type: 'test', revision_id: 'test', revision_number: 1 },
        site: { id: 'test', name: '测试站点', adapter_type: 'test', base_url: null, tags: [] },
        details: { test: true },
        detected_at: sentAt,
        test: true,
        sent_at: sentAt,
        channel: { id: channel.id, name: channel.name },
      });
      prepared = await prepareWebhookRequest(context, channel, {
        eventId,
        idempotencyKey: eventId,
        payloadJson,
        timestamp: new Date(startedAt),
      });
      outbound = await createWebhookFetchContext(channel.url, {
        isProduction: context.config.isProduction,
        allowedCidrs: allowedCidrs(context),
        connectTimeoutMs: channel.timeoutSeconds * 1_000,
        maxResponseBytes: channel.maxResponseBytes,
      });
      const response = await outbound.fetch(outbound.baseUrl, {
        method: 'POST',
        headers: prepared.headers,
        body: prepared.body,
        signal: AbortSignal.timeout(channel.timeoutSeconds * 1_000),
      });
      const responseText = redactWebhookSecrets(
        redactString(await response.text()),
        prepared.sensitiveValues,
      ).slice(0, MAX_TEST_RESPONSE_CHARACTERS);
      result = {
        succeeded: response.ok,
        response_status: response.status,
        duration_ms: Date.now() - startedAt,
        response_body_truncated: responseText || null,
        error_code: response.ok ? null : 'WEBHOOK_HTTP_STATUS',
        error_message: response.ok ? null : `接收端返回 HTTP ${response.status}`,
      };
    } catch (error) {
      result = {
        succeeded: false,
        response_status: null,
        duration_ms: Date.now() - startedAt,
        response_body_truncated: null,
        error_code: error instanceof AppError || error instanceof WebhookRequestConfigurationError
          ? error.code
          : error instanceof UnsafeUrlError
            ? error.code
          : 'WEBHOOK_TEST_FAILED',
        error_message: error instanceof AppError || error instanceof WebhookRequestConfigurationError
          ? error.message
          : `测试请求未完成：${redactWebhookSecrets(
            redactString(webhookOutboundErrorMessage(error)),
            prepared?.sensitiveValues ?? [],
          ).slice(0, 960)}`,
      };
    } finally {
      prepared?.dispose();
      await outbound?.close();
    }
    recordAudit(context.database, request, {
      action: 'notification_channel.test',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      metadata: { succeeded: result.succeeded, response_status: result.response_status },
    });
    return success(request, result);
  });

  typed.post('/api/v1/notification-rules', {
    schema: { tags: ['notifications'], summary: 'Create a versioned notification rule', body: createRuleSchema },
  }, async (request, reply) => {
    const ruleId = createId('rule');
    const revisionId = createId('rulerev');
    const channelIds = requireChannels(context, request.body.channel_ids);
    const condition = conditionFromInput(request.body);
    validateRuleCondition(request.body.type, condition);
    const now = new Date().toISOString();
    context.database.sqlite.transaction(() => {
      context.database.db.insert(notificationRules).values({
        id: ruleId,
        name: request.body.name,
        type: request.body.type,
        enabled: request.body.enabled,
        severity: request.body.severity,
        currentRevisionId: revisionId,
        createdAt: now,
        updatedAt: now,
      }).run();
      context.database.db.insert(notificationRuleRevisions).values({
        id: revisionId,
        ruleId,
        revisionNumber: 1,
        scopeJson: JSON.stringify(request.body.scope),
        conditionJson: JSON.stringify(condition),
        triggerConfirmCount: 1,
        recoveryConfirmCount: request.body.recovery_confirm_count,
        confirmationDurationSeconds: null,
        digestWindowSeconds: request.body.digest_window_seconds,
        cooldownSeconds: request.body.cooldown_seconds,
        repeatIntervalSeconds: request.body.repeat_interval_seconds,
        maxRepeats: request.body.max_repeats,
        sendRecovery: request.body.send_recovery,
        channelIdsJson: JSON.stringify(channelIds),
        createdByAdminId: request.relayAdmin?.id ?? null,
        createdAt: now,
      }).run();
      recordAudit(context.database, request, {
        action: 'notification_rule.create', resourceType: 'notification_rule', resourceId: ruleId,
        metadata: { revision_number: 1, type: request.body.type },
      });
    }).immediate();
    reply.code(201);
    const created = requireRule(context, ruleId);
    return success(request, ruleDto(created.rule, created.revision));
  });

  typed.get('/api/v1/notification-rules', {
    schema: { tags: ['notifications'], summary: 'List notification rules' },
  }, async (request) => {
    const rows = context.database.db.select().from(notificationRules)
      .where(isNull(notificationRules.deletedAt))
      .orderBy(asc(notificationRules.name)).all();
    const items = rows.filter((rule) => !isSystemEventRuleId(rule.id)).map((rule) => {
      const revision = rule.currentRevisionId
        ? context.database.db.select().from(notificationRuleRevisions)
          .where(and(
            eq(notificationRuleRevisions.id, rule.currentRevisionId),
            eq(notificationRuleRevisions.ruleId, rule.id),
          )).get()
        : undefined;
      return revision ? ruleDto(rule, revision) : null;
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    return success(request, items);
  });

  typed.patch('/api/v1/notification-rules/:id', {
    schema: {
      tags: ['notifications'], summary: 'Update a rule by creating a new revision', params: idParamsSchema, body: patchRuleSchema,
    },
  }, async (request) => {
    const current = requireRule(context, request.params.id);
    const condition = {
      ...parseObject(current.revision.conditionJson),
      ...conditionFromInput(request.body),
    };
    const nextType = request.body.type ?? current.rule.type;
    if (request.body.type !== undefined && request.body.event_types === undefined) {
      delete condition.event_types;
    }
    validateRuleCondition(nextType, condition);
    const channelIds = request.body.channel_ids === undefined
      ? parseStringArray(current.revision.channelIdsJson)
      : requireChannels(context, request.body.channel_ids);
    const revisionId = createId('rulerev');
    let revisionNumber = 0;
    const now = new Date().toISOString();
    context.database.sqlite.transaction(() => {
      const lockedCurrent = requireRule(context, current.rule.id);
      if (lockedCurrent.revision.id !== current.revision.id) {
        throw new AppError(
          'NOTIFICATION_RULE_REVISION_CONFLICT',
          '告警规则已被其他请求修改，请刷新后重试',
          409,
        );
      }
      const lockedChannelIds = requireChannels(context, channelIds);
      const latestRevision = context.database.db.select().from(notificationRuleRevisions)
        .where(eq(notificationRuleRevisions.ruleId, current.rule.id))
        .orderBy(desc(notificationRuleRevisions.revisionNumber)).get() ?? current.revision;
      revisionNumber = latestRevision.revisionNumber + 1;
      context.database.db.update(incidents).set({
        state: 'suppressed',
        activeFingerprint: null,
        suppressionReason: request.body.enabled === false ? 'rule_disabled' : 'rule_revision_replaced',
        updatedAt: now,
      }).where(and(
        eq(incidents.ruleRevisionId, current.revision.id),
        inArray(incidents.state, ['pending', 'firing', 'acknowledged', 'recovering']),
      )).run();
      context.database.db.insert(notificationRuleRevisions).values({
        id: revisionId,
        ruleId: current.rule.id,
        revisionNumber,
        scopeJson: JSON.stringify(request.body.scope ?? parseObject(current.revision.scopeJson)),
        conditionJson: JSON.stringify(condition),
        triggerConfirmCount: 1,
        recoveryConfirmCount: request.body.recovery_confirm_count ?? current.revision.recoveryConfirmCount,
        confirmationDurationSeconds: null,
        digestWindowSeconds: request.body.digest_window_seconds ?? current.revision.digestWindowSeconds,
        cooldownSeconds: request.body.cooldown_seconds ?? current.revision.cooldownSeconds,
        repeatIntervalSeconds: request.body.repeat_interval_seconds ?? current.revision.repeatIntervalSeconds,
        maxRepeats: request.body.max_repeats ?? current.revision.maxRepeats,
        sendRecovery: request.body.send_recovery ?? current.revision.sendRecovery,
        channelIdsJson: JSON.stringify(lockedChannelIds),
        createdByAdminId: request.relayAdmin?.id ?? null,
        createdAt: now,
      }).run();
      const updated = context.database.db.update(notificationRules).set({
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.type === undefined ? {} : { type: request.body.type }),
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
        ...(request.body.severity === undefined ? {} : { severity: request.body.severity }),
        currentRevisionId: revisionId,
        updatedAt: now,
      }).where(and(
        eq(notificationRules.id, current.rule.id),
        eq(notificationRules.currentRevisionId, current.revision.id),
        isNull(notificationRules.deletedAt),
      )).run();
      if (updated.changes !== 1) {
        throw new AppError(
          'NOTIFICATION_RULE_REVISION_CONFLICT',
          '告警规则已被其他请求修改，请刷新后重试',
          409,
        );
      }
      recordAudit(context.database, request, {
        action: 'notification_rule.update', resourceType: 'notification_rule', resourceId: current.rule.id,
        metadata: { revision_number: revisionNumber, changed_fields: Object.keys(request.body) },
      });
    }).immediate();
    const updated = requireRule(context, current.rule.id);
    return success(request, ruleDto(updated.rule, updated.revision));
  });

  typed.delete('/api/v1/notification-rules/:id', {
    schema: { tags: ['notifications'], summary: '删除告警规则并停止后续评估', params: idParamsSchema },
  }, async (request) => {
    context.database.sqlite.transaction(() => {
      const current = requireRule(context, request.params.id);
      const revisionIds = context.database.db.select({ id: notificationRuleRevisions.id })
        .from(notificationRuleRevisions)
        .where(eq(notificationRuleRevisions.ruleId, current.rule.id)).all()
        .map(({ id }) => id);
      const relatedIncidents = context.database.db.select({ id: incidents.id }).from(incidents)
        .where(inArray(incidents.ruleRevisionId, revisionIds)).all();
      const incidentIds = relatedIncidents.map(({ id }) => id);
      const sending = incidentIds.length === 0
        ? undefined
        : context.database.db.select({ id: outboxMessages.id }).from(outboxMessages)
          .where(and(
            inArray(outboxMessages.incidentId, incidentIds),
            eq(outboxMessages.state, 'sending'),
          )).get();
      if (sending) {
        throw new AppError(
          'NOTIFICATION_RULE_DELIVERY_IN_PROGRESS',
          'Notification rule has a delivery in progress; retry deletion after it completes',
          409,
        );
      }

      const now = new Date().toISOString();
      const cancellable = incidentIds.length === 0
        ? []
        : context.database.db.select({ id: outboxMessages.id }).from(outboxMessages)
          .where(and(
            inArray(outboxMessages.incidentId, incidentIds),
            inArray(outboxMessages.state, ['pending', 'retry']),
          )).all();
      if (cancellable.length > 0) {
        context.database.db.update(outboxMessages).set({
          state: 'dead',
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: 'NOTIFICATION_RULE_DELETED',
          lastErrorMessage: '告警规则已删除，投递已取消',
          updatedAt: now,
        }).where(inArray(outboxMessages.id, cancellable.map(({ id }) => id))).run();
      }

      if (incidentIds.length > 0) {
        context.database.db.update(incidents).set({
          state: 'suppressed',
          activeFingerprint: null,
          suppressionReason: 'rule_deleted',
          updatedAt: now,
        }).where(and(
          inArray(incidents.id, incidentIds),
          inArray(incidents.state, ['pending', 'firing', 'acknowledged', 'recovering']),
        )).run();
      }
      context.database.db.update(notificationRules).set({
        enabled: false,
        deletedAt: now,
        updatedAt: now,
      }).where(eq(notificationRules.id, current.rule.id)).run();
      recordAudit(context.database, request, {
        action: 'notification_rule.soft_delete',
        resourceType: 'notification_rule',
        resourceId: current.rule.id,
        metadata: {
          deletion_mode: 'soft',
          retained_incident_count: incidentIds.length,
          cancelled_delivery_count: cancellable.length,
        },
      });
    }).immediate();
    return success(request, null);
  });

  typed.get('/api/v1/incidents', {
    schema: {
      tags: ['incidents'],
      summary: 'List current and historical incidents',
      querystring: paginationSchema.extend({
        state: z.enum(INCIDENT_STATES).optional(),
        severity: z.enum(SEVERITIES).optional(),
        site_id: z.string().max(80).optional(),
        event_type: z.string().max(120).optional(),
        search: z.string().trim().max(200).optional(),
      }),
    },
  }, async (request) => {
    const search = request.query.search?.toLocaleLowerCase();
    const filtered = context.database.db.select().from(incidents)
      .where(isNull(incidents.deletedAt))
      .orderBy(desc(incidents.lastObservedAt)).all()
      .filter((row) =>
        (!request.query.state || row.state === request.query.state) &&
        (!request.query.severity || row.severity === request.query.severity) &&
        (!request.query.site_id || row.siteId === request.query.site_id) &&
        (!request.query.event_type || row.eventType === request.query.event_type) &&
        (!search || row.summary.toLocaleLowerCase().includes(search) || row.resourceKey.toLocaleLowerCase().includes(search))
      );
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: filtered.slice(offset, offset + request.query.page_size).map((row) => incidentDto(context, row)),
      page: request.query.page,
      page_size: request.query.page_size,
      total: filtered.length,
    });
  });

  typed.delete('/api/v1/incidents/:id', {
    schema: { tags: ['incidents'], summary: '永久删除事件及关联通知历史', params: idParamsSchema },
  }, async (request) => {
    const incident = requireIncident(context, request.params.id);
    context.database.sqlite.transaction(() => {
      const result = deleteIncidentRecords(context, [incident.id], true);
      recordAudit(context.database, request, {
        action: 'incident.delete',
        resourceType: 'incident',
        resourceId: incident.id,
        metadata: {
          previous_state: incident.state,
          event_type: incident.eventType,
          site_id: incident.siteId,
          deleted_incident_count: result.deletedCount,
          deleted_notification_history: true,
        },
      });
    }).immediate();
    return success(request, null);
  });

  typed.post('/api/v1/incidents/batch-delete', {
    schema: {
      tags: ['incidents'],
      summary: '永久删除选中的事件及关联通知历史',
      body: batchDeleteIncidentsSchema,
    },
  }, async (request) => {
    let result!: { deletedCount: number; deletedIds: string[] };
    context.database.sqlite.transaction(() => {
      result = deleteIncidentRecords(context, request.body.ids, true);
      recordAudit(context.database, request, {
        action: 'incident.batch_delete',
        resourceType: 'incident',
        metadata: { requested_count: request.body.ids.length, deleted_count: result.deletedCount },
      });
    }).immediate();
    return success(request, { deleted_count: result.deletedCount });
  });

  typed.post('/api/v1/incidents/delete-by-time', {
    schema: {
      tags: ['incidents'],
      summary: '永久删除最近观测时间在指定时间及以前的事件',
      body: deleteIncidentsByTimeSchema,
    },
  }, async (request) => {
    const before = new Date(request.body.before).toISOString();
    let result!: { deletedCount: number; deletedIds: string[] };
    context.database.sqlite.transaction(() => {
      const ids = context.database.db.select({ id: incidents.id }).from(incidents)
        .where(lte(incidents.lastObservedAt, before)).all().map(({ id }) => id);
      result = deleteIncidentRecords(context, ids, false);
      recordAudit(context.database, request, {
        action: 'incident.delete_by_time',
        resourceType: 'incident',
        metadata: { before, deleted_count: result.deletedCount },
      });
    }).immediate();
    return success(request, { deleted_count: result.deletedCount });
  });

  typed.delete('/api/v1/incidents', {
    schema: { tags: ['incidents'], summary: '永久删除全部事件及关联通知历史' },
  }, async (request) => {
    let result!: { deletedCount: number; deletedIds: string[] };
    context.database.sqlite.transaction(() => {
      const ids = context.database.db.select({ id: incidents.id }).from(incidents).all().map(({ id }) => id);
      result = deleteIncidentRecords(context, ids, false);
      recordAudit(context.database, request, {
        action: 'incident.delete_all',
        resourceType: 'incident',
        metadata: { deleted_count: result.deletedCount },
      });
    }).immediate();
    return success(request, { deleted_count: result.deletedCount });
  });

  typed.post('/api/v1/incidents/:id/silence', {
    schema: {
      tags: ['incidents'], summary: 'Create a temporary silence for an incident', params: idParamsSchema, body: incidentSilenceSchema,
    },
  }, async (request, reply) => {
    const incident = requireIncident(context, request.params.id);
    const startsAt = new Date();
    const endsAt = request.body.expires_at
      ? new Date(request.body.expires_at)
      : new Date(startsAt.getTime() + (request.body.duration_seconds ?? 3_600) * 1_000);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new AppError('INVALID_TIME_RANGE', '临时静默结束时间必须晚于当前时间', 400);
    }
    const id = createId('silence');
    const matcher = {
      incident_ids: [incident.id],
      fingerprints: [incident.fingerprint],
      ...(incident.siteId ? { site_ids: [incident.siteId] } : {}),
    };
    context.database.db.insert(silences).values({
      id,
      matcherJson: JSON.stringify(matcher),
      reason: request.body.reason,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      createdByAdminId: request.relayAdmin?.id ?? null,
    }).run();
    recordAudit(context.database, request, {
      action: 'incident.silence', resourceType: 'incident', resourceId: incident.id,
      metadata: { silence_id: id, ends_at: endsAt.toISOString() },
    });
    reply.code(201);
    return success(request, {
      id,
      matcher,
      reason: request.body.reason,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    });
  });

  typed.get('/api/v1/notification-deliveries', {
    schema: {
      tags: ['notifications'],
      summary: 'List webhook delivery attempts',
      querystring: paginationSchema.extend({
        channel_id: z.string().max(80).optional(),
        incident_id: z.string().max(80).optional(),
        succeeded: queryBooleanSchema.optional(),
        outbox_state: z.enum(['pending', 'sending', 'retry', 'sent', 'dead']).optional(),
      }),
    },
  }, async (request) => {
    const joined = context.database.db.select({ delivery: notificationDeliveries, outbox: outboxMessages })
      .from(notificationDeliveries)
      .innerJoin(outboxMessages, eq(notificationDeliveries.outboxMessageId, outboxMessages.id))
      .orderBy(desc(notificationDeliveries.createdAt)).all();
    const filtered = joined.filter(({ delivery, outbox }) =>
      (!request.query.channel_id || outbox.channelId === request.query.channel_id) &&
      (!request.query.incident_id || outbox.incidentId === request.query.incident_id) &&
      (request.query.succeeded === undefined || delivery.succeeded === request.query.succeeded) &&
      (!request.query.outbox_state || outbox.state === request.query.outbox_state)
    );
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: filtered.slice(offset, offset + request.query.page_size)
        .map(({ delivery, outbox }) => deliveryDto(context, delivery, outbox)),
      page: request.query.page,
      page_size: request.query.page_size,
      total: filtered.length,
    });
  });

  typed.post('/api/v1/notification-deliveries/:id/replay', {
    schema: { tags: ['notifications'], summary: 'Requeue the existing outbox message for a failed delivery', params: idParamsSchema },
  }, async (request, reply) => {
    const idempotency = claimIdempotencyKey(context.database, {
      scope: `${request.relayAdmin?.id ?? 'anonymous'}:POST:/api/v1/notification-deliveries/replay`,
      key: request.headers['idempotency-key'],
      request: { delivery_id: request.params.id },
    });
    if (idempotency.kind === 'replay') {
      reply.code(idempotency.responseStatus);
      return idempotency.responseBody;
    }

    try {
    const delivery = context.database.db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, request.params.id)).get();
    if (!delivery) throw new AppError('NOTIFICATION_DELIVERY_NOT_FOUND', '通知投递记录不存在', 404);
    if (delivery.succeeded) {
      throw new AppError('NOTIFICATION_DELIVERY_ALREADY_SUCCEEDED', '已成功的通知投递不能重放', 409);
    }
    const outbox = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, delivery.outboxMessageId)).get();
    if (!outbox) throw new AppError('OUTBOX_MESSAGE_NOT_FOUND', '通知队列消息不存在', 404);
    if (['sent', 'sending'].includes(outbox.state)) {
      throw new AppError('OUTBOX_MESSAGE_NOT_REPLAYABLE', '通知已发送或正在发送，当前不能重放', 409);
    }
    const now = new Date().toISOString();
    let response: unknown;
    context.database.sqlite.transaction(() => {
      if (outbox.state !== 'pending') {
        context.database.db.update(outboxMessages).set({
          state: 'pending',
          nextAttemptAt: now,
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          sentAt: null,
          updatedAt: now,
        }).where(eq(outboxMessages.id, outbox.id)).run();
      }
      recordAudit(context.database, request, {
        action: 'notification_delivery.replay',
        resourceType: 'outbox_message',
        resourceId: outbox.id,
        metadata: {
          delivery_id: delivery.id,
          event_id: outbox.eventId,
          already_queued: outbox.state === 'pending',
        },
      });
      const queued = context.database.db.select().from(outboxMessages)
        .where(eq(outboxMessages.id, outbox.id)).get() ?? outbox;
      response = success(request, {
        outbox_message_id: queued.id,
        incident_id: queued.incidentId,
        event_id: queued.eventId,
        idempotency_key: queued.idempotencyKey,
        state: queued.state,
        attempts: queued.attempts,
        next_attempt_at: queued.nextAttemptAt,
      });
      completeIdempotencyKey(context.database, idempotency, {
        responseStatus: 200,
        responseBody: response,
        resourceId: outbox.id,
      });
    }).immediate();
    return response;
    } catch (error) {
      failIdempotencyKey(context.database, idempotency);
      throw error;
    }
  });
}
