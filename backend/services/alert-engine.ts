import { and, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';

import type { AuthStatus, Severity, ServiceStatus } from '../../shared/constants.js';
import type { NotificationEventType } from '../../shared/notification-events.js';
import {
  evaluateAlertState,
  incidentFingerprint,
  initialAlertState,
  type AlertNotification,
  type AlertPolicy,
  type AlertState,
} from '../core/alert-state.js';
import {
  decimalChangeAtLeast,
  decimalChangeDirection,
  evaluateDecimalCondition,
  normalizeDecimalConditionOperator,
} from '../core/alert-conditions.js';
import { decimalsEqual, normalizeDecimal } from '../core/decimal.js';
import { createId } from '../core/ids.js';
import { isMaintenanceWindowActive } from '../core/maintenance.js';
import { redact, redactString } from '../core/redaction.js';
import type { DatabaseConnection } from '../db/client.js';
import {
  incidents,
  maintenanceWindows,
  notificationChannels,
  notificationRuleRevisions,
  notificationRules,
  outboxMessages,
  silences,
  sites,
} from '../db/schema.js';
import { SYSTEM_EVENT_RULE_ID } from './system-event-rule.js';
import {
  readBalanceAlertSettings,
  type BalanceAlertSettingsValue,
} from './balance-alert-settings.js';

type IncidentRow = typeof incidents.$inferSelect;
type RuleRow = typeof notificationRules.$inferSelect;
type RuleRevisionRow = typeof notificationRuleRevisions.$inferSelect;
type SiteRow = typeof sites.$inferSelect;

export type AlertObservationKind = 'health' | 'balance' | 'rate';
export type AlertLabelValue = string | boolean | number | readonly string[];

interface BaseAlertObservation {
  kind: AlertObservationKind;
  siteId: string;
  observedAt: Date | string | number;
  resourceKey?: string | undefined;
  eventType?: string | undefined;
  summary?: string | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
  labels?: Readonly<Record<string, AlertLabelValue>> | undefined;
  violating?: boolean | undefined;
  notificationsAllowed?: boolean | undefined;
  suppressionReason?: string | undefined;
}

export interface HealthAlertObservation extends BaseAlertObservation {
  kind: 'health';
  status: ServiceStatus;
  authenticated?: boolean | null | undefined;
  authStatus?: AuthStatus | undefined;
  probeKind?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  latencyMs?: number | undefined;
}

export interface BalanceAlertObservation extends BaseAlertObservation {
  kind: 'balance';
  balanceKey: string;
  balanceKind?: string | undefined;
  value: string;
  unit?: string | undefined;
}

export interface RateAlertObservation extends BaseAlertObservation {
  kind: 'rate';
  rateKey: string;
  rateKind?: string | undefined;
  rateName?: string | undefined;
  value: string | null;
  previousValue?: string | null | undefined;
  comparisonKey?: string | undefined;
  previousComparisonKey?: string | undefined;
  platform?: string | undefined;
  direction?: 'up' | 'down' | 'unchanged' | undefined;
  changeType?: string | undefined;
  changed?: boolean | undefined;
}

export type AlertEngineObservation =
  | HealthAlertObservation
  | BalanceAlertObservation
  | RateAlertObservation;

export interface AlertRuleEvaluationResult {
  ruleId: string;
  ruleRevisionId: string;
  incidentId: string | null;
  fingerprint: string;
  eventType: string;
  resourceKey: string;
  violating: boolean;
  previousState: AlertState['status'];
  state: AlertState['status'];
  notifications: readonly AlertNotification[];
  outboxMessageIds: readonly string[];
}

export interface AlertEngineEvaluationResult {
  observedAt: string;
  matchedRuleCount: number;
  evaluations: readonly AlertRuleEvaluationResult[];
  incidentIds: readonly string[];
  outboxMessageIds: readonly string[];
}

export class AlertEngineTransactionError extends Error {
  constructor() {
    super('Alert evaluation must run inside a caller-supplied SQLite transaction');
    this.name = 'AlertEngineTransactionError';
  }
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function timestamp(value: Date | string | number): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('observedAt must be a valid timestamp');
  return parsed.toISOString();
}

function ruleAppliesToObservation(ruleType: string, kind: AlertObservationKind): boolean {
  if (kind === 'health') {
    return ['monitor_events', 'site_down', 'site_health', 'health', 'health_status', 'auth_failed'].includes(ruleType);
  }
  if (kind === 'balance') {
    return ['monitor_events', 'balance_low', 'balance_threshold'].includes(ruleType);
  }
  return ['monitor_events', 'rate_changed', 'rate_threshold'].includes(ruleType);
}

function eventTypeFor(rule: RuleRow, observation: AlertEngineObservation): string {
  if (observation.kind === 'health') {
    if (rule.type === 'site_down') return 'site.down';
    if (rule.type === 'auth_failed') return 'auth.failed';
    return 'health.status';
  }
  if (observation.eventType) return observation.eventType;
  if (observation.kind === 'balance') {
    return rule.type === 'balance_threshold' ? 'balance.threshold' : 'balance.low';
  }
  return rule.type === 'rate_threshold' ? 'rate.threshold' : 'rate.changed';
}

function observationHttpStatus(observation: AlertEngineObservation): number | undefined {
  const value = observation.details?.http_status;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function detailedAlertEventType(
  rule: Pick<RuleRow, 'type'>,
  observation: AlertEngineObservation,
): string {
  if (observation.kind === 'balance') return eventTypeFor(rule as RuleRow, observation);
  if (observation.kind === 'rate') {
    if (observation.eventType?.startsWith('probe.')) {
      return observation.eventType === 'probe.failed' && observation.violating === false
        ? 'probe.recovered'
        : observation.eventType;
    }
    if (rule.type === 'rate_threshold') return 'rate.threshold';
    if (observation.changeType === 'added') return 'rate.added';
    if (observation.changeType === 'removed') return 'rate.removed';
    return 'rate.changed';
  }

  const httpStatus = observationHttpStatus(observation);
  const errorCode = observation.errorCode ?? '';
  const errorMessage = observation.errorMessage?.toLocaleLowerCase() ?? '';
  const recovered = observation.status === 'healthy'
    || observation.authenticated === true
    || observation.authStatus === 'authenticated';
  if (recovered) return 'site.recovered';
  if (httpStatus === 403) return 'site.permission_denied';
  if (httpStatus === 401 || errorCode.startsWith('AUTH_') || (
    observation.authStatus !== undefined
    && !['authenticated', 'refreshing'].includes(observation.authStatus)
  )) return 'site.auth_expired';
  if (httpStatus === 429 || errorCode === 'UPSTREAM_RATE_LIMITED') return 'site.rate_limited';
  if ((httpStatus !== undefined && httpStatus >= 500) || errorCode === 'UPSTREAM_SERVER_ERROR') {
    return 'site.upstream_5xx';
  }
  if (errorCode === 'UPSTREAM_SCHEMA_ERROR') return 'site.schema_incompatible';
  if (errorCode === 'UPSTREAM_UNREACHABLE' && /time(?:d)?\s*out|timeout|超时/.test(errorMessage)) {
    return 'site.timeout';
  }
  if (errorCode === 'UPSTREAM_UNREACHABLE' || observation.status === 'down') {
    return 'site.network_unreachable';
  }
  return 'site.other_error';
}

const AUTH_ROOT_EVENT_TYPES = ['site.auth_expired', 'site.permission_denied'] as const;
const AUTH_ROOT_ACTIVE_STATES = ['pending', 'firing', 'acknowledged', 'recovering'] as const;
const AUTH_ROOT_MERGE_REASON = 'auth_root_cause_merged';

function isAuthRootEventType(eventType: string): boolean {
  return AUTH_ROOT_EVENT_TYPES.includes(eventType as (typeof AUTH_ROOT_EVENT_TYPES)[number]);
}

function isAuthenticationRecovery(
  rule: RuleRow,
  observation: AlertEngineObservation,
  eventType: string,
): boolean {
  return observation.kind === 'health'
    && eventType === 'site.recovered'
    && (
      rule.type === 'auth_failed'
      || observation.resourceKey === 'auth'
      || observation.probeKind === 'auth'
      || observation.eventType === 'auth.failed'
    );
}

function resourceKeyFor(
  rule: RuleRow,
  observation: AlertEngineObservation,
  eventType: string,
): string {
  if (observation.kind === 'health' && (
    isAuthRootEventType(eventType)
    || isAuthenticationRecovery(rule, observation, eventType)
  )) return 'auth';
  if (observation.resourceKey) return observation.resourceKey;
  if (observation.kind === 'health') return rule.type === 'auth_failed' ? 'auth' : 'site';
  if (observation.kind === 'balance') return `balance:${observation.balanceKey}`;
  return `rate:${observation.rateKey}`;
}

function aliasesForMatcherKey(key: string): readonly string[] {
  const aliases: Readonly<Record<string, readonly string[]>> = {
    adapter_types: ['adapter_type'],
    balance_keys: ['balance_key'],
    event_types: ['event_type'],
    incident_ids: ['incident_id'],
    platforms: ['platform'],
    rate_keys: ['rate_key'],
    rate_kinds: ['rate_kind'],
    resource_keys: ['resource_key'],
    rule_ids: ['rule_id'],
    rule_types: ['rule_type'],
    severities: ['severity'],
    site_ids: ['site_id'],
  };
  return aliases[key] ?? [key];
}

function selectorMatches(actual: AlertLabelValue | undefined, expected: unknown, key: string): boolean {
  if (Array.isArray(expected)) {
    if (expected.length === 0) return true;
    const expectedValues = expected.filter(
      (item): item is string | boolean | number => ['string', 'boolean', 'number'].includes(typeof item),
    );
    if (expectedValues.length !== expected.length || actual === undefined) return false;
    if (Array.isArray(actual)) {
      return key === 'tags'
        ? expectedValues.every((item) => actual.includes(String(item)))
        : expectedValues.some((item) => actual.includes(String(item)));
    }
    return expectedValues.some((item) => item === actual);
  }
  if (expected !== null && typeof expected === 'object') {
    const selector = expected as Record<string, unknown>;
    if ('in' in selector) return selectorMatches(actual, selector.in, key);
    if ('not_in' in selector) return !selectorMatches(actual, selector.not_in, key);
    if ('equals' in selector) return selectorMatches(actual, selector.equals, key);
    return false;
  }
  if (actual === undefined) return false;
  if (Array.isArray(actual)) return actual.includes(String(expected));
  return actual === expected;
}

export function alertLabelsMatch(
  matcher: Readonly<Record<string, unknown>>,
  labels: Readonly<Record<string, AlertLabelValue>>,
): boolean {
  for (const [key, expected] of Object.entries(matcher)) {
    if (key === 'label' || expected === undefined || expected === null) continue;
    if (key === 'labels' && typeof expected === 'object' && !Array.isArray(expected)) {
      if (!alertLabelsMatch(expected as Record<string, unknown>, labels)) return false;
      continue;
    }
    const aliases = aliasesForMatcherKey(key);
    const actual = aliases.map((alias) => labels[alias]).find((value) => value !== undefined);
    if (!selectorMatches(actual, expected, key)) return false;
  }
  return true;
}

function labelsFor(
  rule: RuleRow,
  site: SiteRow,
  observation: AlertEngineObservation,
  eventType: string,
  resourceKey: string,
  incidentEventType?: string,
): Record<string, AlertLabelValue> {
  const labels: Record<string, AlertLabelValue> = {
    severity: rule.severity,
    site_id: site.id,
    adapter_type: site.adapterType,
    event_type: eventType,
    ...(incidentEventType ? { incident_event_type: incidentEventType } : {}),
    resource_key: resourceKey,
    rule_id: rule.id,
    rule_type: rule.type,
    tags: parseStringArray(site.tagsJson),
    ...(observation.labels ?? {}),
  };
  if (observation.kind === 'balance') {
    labels.balance_key = observation.balanceKey;
    if (observation.balanceKind) labels.balance_kind = observation.balanceKind;
  } else if (observation.kind === 'rate') {
    labels.rate_key = observation.rateKey;
    if (observation.rateKind) labels.rate_kind = observation.rateKind;
    if (observation.platform) labels.platform = observation.platform;
  } else if (observation.probeKind) {
    labels.probe_kind = observation.probeKind;
  }
  if (observation.kind === 'health' && observation.authStatus) labels.auth_status = observation.authStatus;
  return labels;
}

function conditionString(
  condition: Readonly<Record<string, unknown>>,
  key: string,
  required = false,
): string | undefined {
  const value = condition[key];
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`Alert condition ${key} must be a decimal string`);
    return undefined;
  }
  if (typeof value !== 'string') throw new TypeError(`Alert condition ${key} must be a decimal string`);
  return value;
}

function usesRecoveryThreshold(incident: IncidentRow | undefined): boolean {
  return incident !== undefined && ['firing', 'acknowledged', 'recovering'].includes(incident.state);
}

function balanceViolates(
  rule: RuleRow,
  observation: BalanceAlertObservation,
  condition: Readonly<Record<string, unknown>>,
  incident: IncidentRow | undefined,
  globalSettings: BalanceAlertSettingsValue | undefined,
): boolean {
  if (rule.type === 'monitor_events') {
    if (!globalSettings?.enabled) return false;
    return evaluateDecimalCondition(
      normalizeDecimal(observation.value),
      'lt',
      normalizeDecimal(globalSettings.threshold),
    );
  }
  if (typeof condition.balance_key === 'string' && condition.balance_key !== observation.balanceKey) return false;
  const threshold = normalizeDecimal(conditionString(condition, 'threshold', true)!);
  const recoveryThresholdRaw = conditionString(condition, 'recovery_threshold');
  const recoveryThreshold = recoveryThresholdRaw === undefined
    ? undefined
    : normalizeDecimal(recoveryThresholdRaw);
  const operator = normalizeDecimalConditionOperator(condition.operator, 'lt');
  const effectiveThreshold = usesRecoveryThreshold(incident) && recoveryThreshold !== undefined
    ? recoveryThreshold
    : threshold;
  return evaluateDecimalCondition(normalizeDecimal(observation.value), operator, effectiveThreshold);
}

function rateDirection(observation: RateAlertObservation): 'up' | 'down' | 'unchanged' | undefined {
  if (observation.direction) return observation.direction;
  if (observation.previousValue === undefined || observation.previousValue === null || observation.value === null) {
    return undefined;
  }
  return decimalChangeDirection(observation.previousValue, observation.value);
}

function rateChanged(observation: RateAlertObservation): boolean {
  if (observation.changed !== undefined) return observation.changed;
  if (observation.changeType !== undefined) return observation.changeType !== 'unchanged';
  if (observation.previousValue === undefined) return false;
  if (observation.previousValue === null || observation.value === null) {
    return observation.previousValue !== observation.value;
  }
  return !decimalsEqual(observation.previousValue, observation.value);
}

function rateViolates(
  rule: RuleRow,
  observation: RateAlertObservation,
  condition: Readonly<Record<string, unknown>>,
  incident: IncidentRow | undefined,
): boolean {
  if (rule.type === 'rate_threshold') {
    if (observation.value === null) return false;
    const threshold = normalizeDecimal(conditionString(condition, 'threshold', true)!);
    const recoveryThresholdRaw = conditionString(condition, 'recovery_threshold');
    const effectiveThreshold = usesRecoveryThreshold(incident) && recoveryThresholdRaw !== undefined
      ? normalizeDecimal(recoveryThresholdRaw)
      : threshold;
    const operator = normalizeDecimalConditionOperator(condition.operator, 'gt');
    return evaluateDecimalCondition(normalizeDecimal(observation.value), operator, effectiveThreshold);
  }

  if (!rateChanged(observation)) return false;
  if (observation.changeType === 'added' || observation.changeType === 'removed') return true;
  const directions = condition.directions;
  if (Array.isArray(directions) && directions.length > 0) {
    const direction = rateDirection(observation);
    if (direction === undefined || !directions.includes(direction)) return false;
  }
  const minimumChange = conditionString(condition, 'minimum_change')
    ?? conditionString(condition, 'min_change')
    ?? conditionString(condition, 'threshold');
  if (minimumChange !== undefined) {
    if (observation.previousValue === undefined || observation.previousValue === null || observation.value === null) {
      return false;
    }
    if (!decimalChangeAtLeast(observation.previousValue, observation.value, minimumChange)) return false;
  }
  return true;
}

function healthViolates(
  rule: RuleRow,
  observation: HealthAlertObservation,
  condition: Readonly<Record<string, unknown>>,
): boolean {
  if (rule.type === 'auth_failed') {
    const configuredStatuses = condition.auth_statuses ?? condition.statuses;
    if (Array.isArray(configuredStatuses) && observation.authStatus !== undefined) {
      return configuredStatuses.includes(observation.authStatus);
    }
    if (observation.authenticated === false) return true;
    if (
      observation.authStatus !== undefined &&
      !['authenticated', 'refreshing'].includes(observation.authStatus)
    ) return true;
    return observation.errorCode?.startsWith('AUTH_') ?? false;
  }
  const statuses = condition.statuses;
  if (Array.isArray(statuses)) return statuses.includes(observation.status);
  const expected = typeof condition.status === 'string'
    ? condition.status
    : typeof condition.threshold === 'string'
      ? condition.threshold
      : rule.type === 'site_down' ? 'down' : 'healthy';
  const operator = condition.operator ?? (rule.type === 'site_down' ? 'eq' : 'ne');
  if (!['eq', '==', '=', 'ne', '!='].includes(String(operator).toLowerCase())) {
    throw new TypeError('Health status conditions support only eq and ne operators');
  }
  const equal = observation.status === expected;
  return ['ne', '!='].includes(String(operator).toLowerCase()) ? !equal : equal;
}

function violates(
  rule: RuleRow,
  observation: AlertEngineObservation,
  condition: Readonly<Record<string, unknown>>,
  incident: IncidentRow | undefined,
  globalBalanceSettings: BalanceAlertSettingsValue | undefined,
): boolean {
  if (observation.kind === 'balance' && rule.type === 'monitor_events') {
    return balanceViolates(rule, observation, condition, incident, globalBalanceSettings);
  }
  if (observation.violating !== undefined) return observation.violating;
  if (observation.kind === 'balance') {
    return balanceViolates(rule, observation, condition, incident, globalBalanceSettings);
  }
  if (observation.kind === 'rate') return rateViolates(rule, observation, condition, incident);
  return healthViolates(rule, observation, condition);
}

function policyFor(revision: RuleRevisionRow, sendRecovery = revision.sendRecovery): AlertPolicy {
  return {
    recoveryConfirmations: revision.recoveryConfirmCount,
    cooldownMs: revision.cooldownSeconds * 1_000,
    repeatIntervalMs: revision.repeatIntervalSeconds * 1_000,
    maxRepeats: revision.maxRepeats,
    sendRecovery,
  };
}

function stateFor(incident: IncidentRow): AlertState {
  const status = incident.state === 'pending' || incident.state === 'acknowledged'
    ? 'firing'
    : incident.state as AlertState['status'];
  return {
    status,
    violationCount: incident.triggerCount,
    recoveryCount: incident.recoveryCount,
    repeatCount: incident.repeatCount,
    lastObservedAt: incident.lastObservedAt,
    ...(incident.firedAt ? { firstFiredAt: incident.firedAt } : {}),
    ...(incident.lastNotifiedAt ? { lastNotifiedAt: incident.lastNotifiedAt } : {}),
    ...(incident.suppressionReason ? {
      suppressionActive: true,
      suppressedBy: incident.suppressionReason,
    } : {}),
  };
}

function detailsFor(observation: AlertEngineObservation): Record<string, unknown> {
  const common = { kind: observation.kind, ...(observation.details ?? {}) };
  let details: Record<string, unknown>;
  if (observation.kind === 'health') {
    details = {
      ...common,
      status: observation.status,
      authenticated: observation.authenticated ?? null,
      auth_status: observation.authStatus ?? null,
      probe_kind: observation.probeKind ?? null,
      latency_ms: observation.latencyMs ?? null,
      error_code: observation.errorCode ?? null,
      error_message: observation.errorMessage ?? null,
    };
  } else if (observation.kind === 'balance') {
    details = {
      ...common,
      balance_key: observation.balanceKey,
      balance_kind: observation.balanceKind ?? null,
      value: normalizeDecimal(observation.value),
      unit: observation.unit ?? null,
    };
  } else {
    details = {
      ...common,
      rate_key: observation.rateKey,
      rate_kind: observation.rateKind ?? null,
      rate_name: observation.rateName ?? null,
      comparison_key: observation.comparisonKey ?? null,
      previous_comparison_key: observation.previousComparisonKey ?? null,
      old_rate: observation.previousValue === undefined || observation.previousValue === null
        ? null
        : normalizeDecimal(observation.previousValue),
      new_rate: observation.value === null ? null : normalizeDecimal(observation.value),
      direction: rateDirection(observation) ?? null,
      change_type: observation.changeType ?? null,
      platform: observation.platform ?? null,
    };
  }
  return redact(details) as Record<string, unknown>;
}

function summaryFor(
  rule: RuleRow,
  site: SiteRow,
  observation: AlertEngineObservation,
  condition: Readonly<Record<string, unknown>>,
  globalBalanceSettings: BalanceAlertSettingsValue | undefined,
): string {
  if (observation.summary) {
    const summary = redactString(observation.summary);
    return observation.kind === 'rate' && observation.eventType?.startsWith('probe.')
      ? `${site.name} · ${summary}`
      : summary;
  }
  if (observation.kind === 'health') {
    const recovered = observation.status === 'healthy'
      || observation.authenticated === true
      || observation.authStatus === 'authenticated';
    const monitorName = {
      user_api: '连通性',
      auth: '登录状态',
      balance: '余额',
      rates: '倍率',
    }[observation.probeKind ?? ''];
    if (recovered && monitorName) return `${site.name} · ${monitorName}监控已恢复。`;
    return rule.type === 'auth_failed'
      ? `${site.name}认证失败。`
      : `${site.name}服务状态为${{
        healthy: '正常', degraded: '降级', down: '宕机', unknown: '未知', adapter_unavailable: '适配器不可用',
      }[observation.status]}。`;
  }
  if (observation.kind === 'balance') {
    const monitorEvents = rule.type === 'monitor_events';
    const operator = monitorEvents ? 'lt' : normalizeDecimalConditionOperator(condition.operator, 'lt');
    const threshold = monitorEvents
      ? globalBalanceSettings?.threshold ?? '未配置'
      : conditionString(condition, 'threshold') ?? '未配置';
    const operatorLabel = {
      lt: '小于', lte: '小于等于', gt: '大于', gte: '大于等于', eq: '等于', ne: '不等于',
    }[operator];
    return `${site.name}的余额 ${observation.balanceKey} 为 ${normalizeDecimal(observation.value)}（${operatorLabel} ${threshold}）。`;
  }
  if (rule.type === 'rate_threshold') {
    return `${site.name}的倍率 ${observation.rateKey} 当前${observation.value === null ? '不可用' : `为 ${normalizeDecimal(observation.value)}`}。`;
  }
  const name = observation.rateName?.trim() || observation.rateKey;
  const oldValue = observation.previousValue === undefined || observation.previousValue === null
    ? null
    : normalizeDecimal(observation.previousValue);
  const newValue = observation.value === null ? null : normalizeDecimal(observation.value);
  if (observation.changeType === 'added') {
    return `${site.name}新增分组“${name}”，倍率为 ${newValue ?? '不可用'}。`;
  }
  if (observation.changeType === 'removed') {
    return `${site.name}移除分组“${name}”${oldValue === null ? '' : `，移除前倍率为 ${oldValue}`}。`;
  }
  return `${site.name}的分组“${name}”倍率由 ${oldValue ?? '未知'} 变为 ${newValue ?? '不可用'}。`;
}

function isPointInTimeRateEvent(
  observation: AlertEngineObservation,
  eventType: string,
  violating: boolean,
): boolean {
  return observation.kind === 'rate'
    && violating
    && ['rate.changed', 'rate.added', 'rate.removed'].includes(eventType);
}

function activeState(status: AlertState['status']): boolean {
  return !['normal', 'resolved'].includes(status);
}

function mergeActiveAuthRootIncidents(input: {
  database: DatabaseConnection;
  siteId: string;
  ruleRevisionId: string;
  fingerprint: string;
  observedAt: string;
}): void {
  const legacy = input.database.db.select().from(incidents).where(and(
    eq(incidents.siteId, input.siteId),
    eq(incidents.ruleRevisionId, input.ruleRevisionId),
    isNull(incidents.deletedAt),
    isNotNull(incidents.activeFingerprint),
    inArray(incidents.state, [...AUTH_ROOT_ACTIVE_STATES]),
    inArray(incidents.eventType, [...AUTH_ROOT_EVENT_TYPES]),
  )).all();
  const canonical = input.database.db.select().from(incidents).where(and(
    eq(incidents.activeFingerprint, input.fingerprint),
    isNull(incidents.deletedAt),
  )).get();
  const candidates = [...new Map(
    [...legacy, ...(canonical ? [canonical] : [])].map((candidate) => [candidate.id, candidate]),
  ).values()];
  if (candidates.length === 0) return;

  const root = canonical
    ?? candidates.find(({ resourceKey }) => resourceKey === 'auth')
    ?? [...candidates].sort((left, right) =>
      left.firstObservedAt.localeCompare(right.firstObservedAt) || left.id.localeCompare(right.id)
    )[0]!;
  const duplicates = candidates.filter(({ id }) => id !== root.id);
  if (duplicates.length > 0) {
    input.database.db.update(incidents).set({
      state: 'suppressed',
      activeFingerprint: null,
      resolvedAt: input.observedAt,
      suppressedByIncidentId: root.id,
      suppressionReason: AUTH_ROOT_MERGE_REASON,
      updatedAt: input.observedAt,
    }).where(inArray(incidents.id, duplicates.map(({ id }) => id))).run();
  }

  const firstObservedAt = candidates.map(({ firstObservedAt: value }) => value).sort()[0]!;
  const lastObservedAt = candidates.map(({ lastObservedAt: value }) => value).sort().at(-1)!;
  const firedAt = candidates.flatMap(({ firedAt: value }) => value === null ? [] : [value]).sort()[0] ?? null;
  const lastNotifiedAt = candidates
    .flatMap(({ lastNotifiedAt: value }) => value === null ? [] : [value])
    .sort()
    .at(-1) ?? null;
  input.database.db.update(incidents).set({
    resourceKey: 'auth',
    fingerprint: input.fingerprint,
    activeFingerprint: input.fingerprint,
    triggerCount: Math.max(...candidates.map(({ triggerCount }) => triggerCount)),
    recoveryCount: Math.max(...candidates.map(({ recoveryCount }) => recoveryCount)),
    repeatCount: Math.max(...candidates.map(({ repeatCount }) => repeatCount)),
    firstObservedAt,
    firedAt,
    lastObservedAt,
    lastNotifiedAt,
    updatedAt: input.observedAt,
  }).where(eq(incidents.id, root.id)).run();
}

const ROOT_CAUSE_EVENT_TYPES = ['site.timeout', 'site.network_unreachable'] as const;
const ROOT_CAUSE_ACTIVE_STATES = ['pending', 'firing', 'acknowledged', 'recovering'] as const;
const ROOT_CAUSE_DEPENDENCY_REASON = 'root_cause_dependency';

function isRootCauseDependency(
  observation: AlertEngineObservation,
  eventType: string,
  resourceKey: string,
): boolean {
  return observation.kind === 'health'
    && observation.errorCode === 'UPSTREAM_UNREACHABLE'
    && ROOT_CAUSE_EVENT_TYPES.includes(eventType as (typeof ROOT_CAUSE_EVENT_TYPES)[number])
    && (resourceKey === 'auth' || resourceKey.startsWith('monitor:'));
}

function activeConnectivityRootCause(
  database: DatabaseConnection,
  siteId: string,
  ruleRevisionId: string,
): IncidentRow | undefined {
  const candidates = database.db.select().from(incidents).where(and(
    eq(incidents.siteId, siteId),
    eq(incidents.ruleRevisionId, ruleRevisionId),
    eq(incidents.resourceKey, 'site'),
    isNotNull(incidents.activeFingerprint),
    isNull(incidents.deletedAt),
    inArray(incidents.state, [...ROOT_CAUSE_ACTIVE_STATES]),
  )).all();
  return candidates.find((candidate) => {
    const details = parseObject(candidate.detailsJson);
    if (typeof details.error_code === 'string') {
      if (details.error_code !== 'UPSTREAM_UNREACHABLE') return false;
      return true;
    }
    if (details.error_code === null) return false;
    if (ROOT_CAUSE_EVENT_TYPES.includes(candidate.eventType as (typeof ROOT_CAUSE_EVENT_TYPES)[number])) {
      return true;
    }
    return false;
  });
}

function resolveRootCauseDependencies(
  database: DatabaseConnection,
  rootIncidentIds: readonly string[],
  observedAt: string,
): void {
  if (rootIncidentIds.length === 0) return;
  database.db.update(incidents).set({
    state: 'resolved',
    activeFingerprint: null,
    resolvedAt: observedAt,
    lastObservedAt: observedAt,
    updatedAt: observedAt,
  }).where(and(
    inArray(incidents.suppressedByIncidentId, [...rootIncidentIds]),
    isNull(incidents.deletedAt),
    inArray(incidents.state, [...ROOT_CAUSE_ACTIVE_STATES]),
  )).run();
}

function activeAt(startsAt: string | null, endsAt: string | null, observedAt: string): boolean {
  const at = Date.parse(observedAt);
  const starts = startsAt === null ? undefined : Date.parse(startsAt);
  const ends = endsAt === null ? undefined : Date.parse(endsAt);
  return (starts === undefined || starts <= at) && (ends === undefined || ends > at);
}

function automaticSuppressionReason(
  database: DatabaseConnection,
  observedAt: string,
  labels: Readonly<Record<string, AlertLabelValue>>,
): string | undefined {
  const maintenance = database.db.select().from(maintenanceWindows)
    .where(and(
      eq(maintenanceWindows.enabled, true),
      isNull(maintenanceWindows.deletedAt),
    )).all()
    .find((window) =>
      isMaintenanceWindowActive(window, observedAt) &&
      alertLabelsMatch(parseObject(window.matcherJson), labels)
    );
  if (maintenance) return `maintenance:${maintenance.id}`;

  const silence = database.db.select().from(silences).all().find((candidate) =>
    candidate.deletedAt === null &&
    activeAt(candidate.startsAt, candidate.endsAt, observedAt) &&
    alertLabelsMatch(parseObject(candidate.matcherJson), labels)
  );
  return silence ? `silence:${silence.id}` : undefined;
}

function ruleChannels(revision: RuleRevisionRow): string[] {
  return [...new Set(parseStringArray(revision.channelIdsJson))];
}

function hasRecentSiteRecoveryNotification(input: {
  database: DatabaseConnection;
  siteId: string;
  revision: RuleRevisionRow;
  observedAt: string;
}): boolean {
  if (input.revision.digestWindowSeconds <= 0) return false;
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs)) return false;
  const cutoff = new Date(observedAtMs - input.revision.digestWindowSeconds * 1_000).toISOString();
  const candidates = input.database.db.select({ payloadJson: outboxMessages.payloadJson })
    .from(outboxMessages)
    .innerJoin(incidents, eq(outboxMessages.incidentId, incidents.id))
    .where(and(
      eq(incidents.siteId, input.siteId),
      eq(incidents.ruleRevisionId, input.revision.id),
      isNull(incidents.deletedAt),
      gte(outboxMessages.createdAt, cutoff),
      lte(outboxMessages.createdAt, input.observedAt),
      inArray(outboxMessages.state, ['pending', 'sending', 'sent', 'retry']),
    )).all();
  return candidates.some(({ payloadJson }) => {
    const payload = parseObject(payloadJson);
    return payload.event === 'site.recovered' && payload.notification_kind === 'recovery';
  });
}

function webhookPayload(input: {
  eventId: string;
  notification: AlertNotification;
  incidentId: string;
  rule: RuleRow;
  revision: RuleRevisionRow;
  site: SiteRow;
  eventType: string;
  resourceKey: string;
  state: AlertState['status'];
  summary: string;
  details: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema_version: '1.0',
    event: input.eventType,
    event_id: input.eventId,
    notification_kind: input.notification.kind,
    severity: input.rule.severity,
    incident: {
      id: input.incidentId,
      state: input.state,
      resource_key: input.resourceKey,
      summary: input.summary,
    },
    rule: {
      id: input.rule.id,
      name: input.rule.name,
      type: input.rule.type,
      revision_id: input.revision.id,
      revision_number: input.revision.revisionNumber,
    },
    site: {
      id: input.site.id,
      name: input.site.name,
      adapter_type: input.site.adapterType,
      base_url: input.site.baseUrl,
      tags: parseStringArray(input.site.tagsJson),
    },
    details: input.details,
    detected_at: input.notification.occurredAt,
  };
  if (input.notification.repeatNumber !== undefined) payload.repeat_number = input.notification.repeatNumber;
  if (input.eventType.startsWith('rate.')) {
    payload.changes = [{
      rate_key: input.details.rate_key,
      rate_kind: input.details.rate_kind,
      rate_name: input.details.rate_name,
      comparison_key: input.details.comparison_key,
      old_rate: input.details.old_rate,
      new_rate: input.details.new_rate,
      direction: input.details.direction,
      change_type: input.details.change_type,
    }];
  }
  return payload;
}

function enqueueNotifications(input: {
  database: DatabaseConnection;
  notifications: readonly AlertNotification[];
  incidentId: string;
  rule: RuleRow;
  revision: RuleRevisionRow;
  site: SiteRow;
  eventType: string;
  resourceKey: string;
  state: AlertState['status'];
  summary: string;
  details: Readonly<Record<string, unknown>>;
}): string[] {
  if (input.notifications.length === 0) return [];
  if (input.rule.id === SYSTEM_EVENT_RULE_ID) return [];
  const selected = ruleChannels(input.revision);
  if (selected.length === 0) return [];
  const enabledChannels = input.database.db.select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(and(
      inArray(notificationChannels.id, selected),
      eq(notificationChannels.enabled, true),
      isNull(notificationChannels.deletedAt),
    )).all();
  const enabledIds = new Set(enabledChannels.map(({ id }) => id));
  const outboxIds: string[] = [];

  for (const notification of input.notifications) {
    const eventId = createId('event', Date.parse(notification.occurredAt));
    const payload = webhookPayload({
      eventId,
      notification,
      incidentId: input.incidentId,
      rule: input.rule,
      revision: input.revision,
      site: input.site,
      eventType: input.eventType,
      resourceKey: input.resourceKey,
      state: input.state,
      summary: input.summary,
      details: input.details,
    });
    for (const channelId of selected) {
      if (!enabledIds.has(channelId)) continue;
      const id = createId('outbox', Date.parse(notification.occurredAt));
      input.database.db.insert(outboxMessages).values({
        id,
        incidentId: input.incidentId,
        channelId,
        eventId,
        idempotencyKey: eventId,
        schemaVersion: '1.0',
        state: 'pending',
        payloadJson: JSON.stringify(payload),
        attempts: 0,
        nextAttemptAt: notification.occurredAt,
        createdAt: notification.occurredAt,
        updatedAt: notification.occurredAt,
      }).run();
      outboxIds.push(id);
    }
  }
  return outboxIds;
}

function evaluateRule(input: {
  database: DatabaseConnection;
  rule: RuleRow;
  revision: RuleRevisionRow;
  site: SiteRow;
  observation: AlertEngineObservation;
  observedAt: string;
  globalBalanceSettings?: BalanceAlertSettingsValue | undefined;
}): AlertRuleEvaluationResult | undefined {
  if (input.observation.kind === 'health') {
    if (input.rule.type === 'site_down' && input.observation.eventType === 'auth.failed') return undefined;
    if (
      input.rule.type === 'auth_failed' &&
      typeof input.observation.authenticated !== 'boolean' &&
      input.observation.authStatus === undefined &&
      !input.observation.errorCode?.startsWith('AUTH_')
    ) return undefined;
  }
  const incidentEventType = eventTypeFor(input.rule, input.observation);
  const eventType = detailedAlertEventType(input.rule, input.observation);
  const resourceKey = resourceKeyFor(input.rule, input.observation, eventType);
  const labels = labelsFor(
    input.rule,
    input.site,
    input.observation,
    eventType,
    resourceKey,
    incidentEventType,
  );
  if (!alertLabelsMatch(parseObject(input.revision.scopeJson), labels)) return undefined;

  const fingerprint = incidentFingerprint({
    ruleRevisionId: input.revision.id,
    siteId: input.site.id,
    resourceKey,
    eventType: incidentEventType,
  });
  if (
    resourceKey === 'auth'
    && (isAuthRootEventType(eventType) || isAuthenticationRecovery(input.rule, input.observation, eventType))
  ) {
    mergeActiveAuthRootIncidents({
      database: input.database,
      siteId: input.site.id,
      ruleRevisionId: input.revision.id,
      fingerprint,
      observedAt: input.observedAt,
    });
  }
  const pointInTimeCandidate = input.observation.kind === 'rate'
    && ['rate.changed', 'rate.added', 'rate.removed'].includes(eventType);
  const incident = pointInTimeCandidate
    ? undefined
    : input.database.db.select().from(incidents)
      .where(eq(incidents.activeFingerprint, fingerprint)).get();
  const condition = parseObject(input.revision.conditionJson);
  const selectedEventTypes = Array.isArray(condition.event_types)
    ? condition.event_types.filter((item): item is NotificationEventType => typeof item === 'string')
    : [];
  const eventSelected = selectedEventTypes.length === 0 || selectedEventTypes.includes(eventType as NotificationEventType);
  const rawViolating = violates(
    input.rule,
    input.observation,
    condition,
    incident,
    input.globalBalanceSettings,
  );
  if (!incident && (!eventSelected || !rawViolating)) {
    return {
      ruleId: input.rule.id,
      ruleRevisionId: input.revision.id,
      incidentId: null,
      fingerprint,
      eventType,
      resourceKey,
      violating: false,
      previousState: 'normal',
      state: 'normal',
      notifications: [],
      outboxMessageIds: [],
    };
  }
  const violating = eventSelected ? rawViolating : false;
  const previous = incident ? stateFor(incident) : initialAlertState();
  if (!incident && !violating) {
    return {
      ruleId: input.rule.id,
      ruleRevisionId: input.revision.id,
      incidentId: null,
      fingerprint,
      eventType,
      resourceKey,
      violating,
      previousState: previous.status,
      state: previous.status,
      notifications: [],
      outboxMessageIds: [],
    };
  }

  const rootCause = isRootCauseDependency(input.observation, eventType, resourceKey)
    ? activeConnectivityRootCause(input.database, input.site.id, input.revision.id)
    : undefined;
  const suppressionLabels: Record<string, AlertLabelValue> = {
    ...labels,
    fingerprint,
    ...(incident ? { incident_id: incident.id } : {}),
  };
  const automaticSuppression = input.observation.notificationsAllowed === undefined
    ? automaticSuppressionReason(input.database, input.observedAt, suppressionLabels)
    : undefined;
  const notificationsAllowed = rootCause
    ? false
    : input.observation.notificationsAllowed ?? automaticSuppression === undefined;
  const observationSuppressionReason = rootCause
    ? ROOT_CAUSE_DEPENDENCY_REASON
    : input.observation.suppressionReason
      ?? automaticSuppression
      ?? (notificationsAllowed ? undefined : 'caller:suppressed');
  const recoverySelected = selectedEventTypes.length === 0
    || selectedEventTypes.includes(eventType as NotificationEventType);
  let evaluation = evaluateAlertState(previous, {
    violating,
    observedAt: input.observedAt,
    notificationsAllowed,
    ...(observationSuppressionReason ? {
      suppressionReason: observationSuppressionReason,
    } : {}),
  }, policyFor(input.revision, input.revision.sendRecovery && recoverySelected));
  if (isPointInTimeRateEvent(input.observation, eventType, violating)) {
    evaluation = {
      ...evaluation,
      state: {
        ...evaluation.state,
        status: 'resolved',
        violationCount: Math.max(1, evaluation.state.violationCount),
        recoveryCount: 0,
      },
    };
  }
  if (
    eventType === 'site.recovered'
    && evaluation.notifications.some(({ kind }) => kind === 'recovery')
    && hasRecentSiteRecoveryNotification({
      database: input.database,
      siteId: input.site.id,
      revision: input.revision,
      observedAt: input.observedAt,
    })
  ) {
    const state = { ...evaluation.state };
    if (previous.lastNotifiedAt === undefined) delete state.lastNotifiedAt;
    else state.lastNotifiedAt = previous.lastNotifiedAt;
    evaluation = { ...evaluation, state, notifications: [] };
  }
  const incidentId = incident?.id ?? createId('incident', Date.parse(input.observedAt));
  const details = detailsFor(input.observation);
  const summary = summaryFor(
    input.rule,
    input.site,
    input.observation,
    condition,
    input.globalBalanceSettings,
  );
  const remainsActive = activeState(evaluation.state.status);
  const stateSuppressionReason = evaluation.state.suppressionActive
    ? evaluation.state.suppressedBy ?? observationSuppressionReason ?? incident?.suppressionReason ?? null
    : null;
  const suppressedByIncidentId = rootCause?.id
    ?? (!remainsActive ? incident?.suppressedByIncidentId ?? null : null);

  if (incident) {
    input.database.db.update(incidents).set({
      state: evaluation.state.status,
      activeFingerprint: remainsActive ? fingerprint : null,
      ...(violating ? { eventType } : {}),
      severity: input.rule.severity,
      summary,
      detailsJson: JSON.stringify(details),
      triggerCount: evaluation.state.violationCount,
      recoveryCount: evaluation.state.recoveryCount,
      repeatCount: evaluation.state.repeatCount,
      firedAt: evaluation.state.firstFiredAt ?? incident.firedAt,
      acknowledgedAt: null,
      acknowledgedByAdminId: null,
      resolvedAt: remainsActive ? null : input.observedAt,
      lastObservedAt: input.observedAt,
      lastNotifiedAt: evaluation.state.lastNotifiedAt ?? incident.lastNotifiedAt,
      suppressedByIncidentId,
      suppressionReason: stateSuppressionReason,
      updatedAt: input.observedAt,
    }).where(eq(incidents.id, incident.id)).run();
  } else {
    input.database.db.insert(incidents).values({
      id: incidentId,
      ruleRevisionId: input.revision.id,
      siteId: input.site.id,
      resourceKey,
      eventType,
      fingerprint,
      activeFingerprint: remainsActive ? fingerprint : null,
      state: evaluation.state.status,
      severity: input.rule.severity as Severity,
      summary,
      detailsJson: JSON.stringify(details),
      triggerCount: evaluation.state.violationCount,
      recoveryCount: evaluation.state.recoveryCount,
      repeatCount: evaluation.state.repeatCount,
      firstObservedAt: input.observedAt,
      firedAt: evaluation.state.firstFiredAt ?? null,
      acknowledgedAt: null,
      resolvedAt: remainsActive ? null : input.observedAt,
      lastObservedAt: input.observedAt,
      lastNotifiedAt: evaluation.state.lastNotifiedAt ?? null,
      suppressedByIncidentId,
      suppressionReason: stateSuppressionReason,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    }).run();
  }

  const outboxMessageIds = enqueueNotifications({
    database: input.database,
    notifications: evaluation.notifications,
    incidentId,
    rule: input.rule,
    revision: input.revision,
    site: input.site,
    eventType,
    resourceKey,
    state: evaluation.state.status,
    summary,
    details,
  });
  return {
    ruleId: input.rule.id,
    ruleRevisionId: input.revision.id,
    incidentId,
    fingerprint,
    eventType,
    resourceKey,
    violating,
    previousState: previous.status,
    state: evaluation.state.status,
    notifications: evaluation.notifications,
    outboxMessageIds,
  };
}

/**
 * Evaluates one collected observation and performs only synchronous database writes.
 * The caller owns the surrounding transaction so collection state and alert state can commit atomically.
 */
export function evaluateAlertRulesInTransaction(
  database: DatabaseConnection,
  observation: AlertEngineObservation,
): AlertEngineEvaluationResult {
  if (!database.sqlite.inTransaction) throw new AlertEngineTransactionError();
  const observedAt = timestamp(observation.observedAt);
  const site = database.db.select().from(sites).where(eq(sites.id, observation.siteId)).get();
  if (!site) throw new Error(`Cannot evaluate alerts for unknown site: ${observation.siteId}`);

  const currentRules = database.db.select({
    rule: notificationRules,
    revision: notificationRuleRevisions,
  }).from(notificationRules)
    .innerJoin(
      notificationRuleRevisions,
      and(
        eq(notificationRules.currentRevisionId, notificationRuleRevisions.id),
        eq(notificationRuleRevisions.ruleId, notificationRules.id),
      ),
    )
    .where(and(
      eq(notificationRules.enabled, true),
      isNull(notificationRules.deletedAt),
    )).all();
  const globalBalanceSettings = observation.kind === 'balance'
    ? readBalanceAlertSettings(database)
    : undefined;
  const evaluations: AlertRuleEvaluationResult[] = [];
  const fallbackRule = currentRules.find(({ rule }) => rule.id === SYSTEM_EVENT_RULE_ID);
  for (const { rule, revision } of currentRules) {
    if (rule.id === SYSTEM_EVENT_RULE_ID) continue;
    if (!ruleAppliesToObservation(rule.type, observation.kind)) continue;
    const evaluation = evaluateRule({
      database,
      rule,
      revision,
      site,
      observation,
      observedAt,
      globalBalanceSettings,
    });
    if (evaluation) evaluations.push(evaluation);
  }
  const userIncidentId = evaluations.find(({ incidentId }) => incidentId !== null)?.incidentId ?? null;
  if (userIncidentId && fallbackRule) {
    const fallbackEventType = detailedAlertEventType(fallbackRule.rule, observation);
    const fallbackResourceKey = resourceKeyFor(fallbackRule.rule, observation, fallbackEventType);
    const replacedFallbackIds = database.db.select({ id: incidents.id }).from(incidents).where(and(
      eq(incidents.ruleRevisionId, fallbackRule.revision.id),
      eq(incidents.siteId, site.id),
      eq(incidents.resourceKey, fallbackResourceKey),
      inArray(incidents.state, [...ROOT_CAUSE_ACTIVE_STATES]),
    )).all().map(({ id }) => id);
    database.db.update(incidents).set({
      state: 'suppressed',
      activeFingerprint: null,
      suppressedByIncidentId: userIncidentId,
      suppressionReason: 'system_fallback_replaced',
      updatedAt: observedAt,
    }).where(and(
      eq(incidents.ruleRevisionId, fallbackRule.revision.id),
      eq(incidents.siteId, site.id),
      eq(incidents.resourceKey, fallbackResourceKey),
      inArray(incidents.state, ['pending', 'firing', 'acknowledged', 'recovering']),
    )).run();
    resolveRootCauseDependencies(database, replacedFallbackIds, observedAt);
  } else if (fallbackRule && ruleAppliesToObservation(fallbackRule.rule.type, observation.kind)) {
    const evaluation = evaluateRule({
      database,
      rule: fallbackRule.rule,
      revision: fallbackRule.revision,
      site,
      observation,
      observedAt,
      globalBalanceSettings,
    });
    if (evaluation) evaluations.push(evaluation);
  }
  const recoveredRootIds = evaluations.filter((evaluation) =>
    evaluation.incidentId !== null
    && evaluation.resourceKey === 'site'
    && evaluation.eventType === 'site.recovered'
    && ['normal', 'resolved'].includes(evaluation.state)
  ).map((evaluation) => evaluation.incidentId!);
  resolveRootCauseDependencies(database, recoveredRootIds, observedAt);
  const incidentIds = [...new Set(
    evaluations.map(({ incidentId }) => incidentId).filter((id): id is string => id !== null),
  )];
  const outboxMessageIds = evaluations.flatMap((evaluation) => evaluation.outboxMessageIds);
  return {
    observedAt,
    matchedRuleCount: evaluations.length,
    evaluations,
    incidentIds,
    outboxMessageIds,
  };
}
