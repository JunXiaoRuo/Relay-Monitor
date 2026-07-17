import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseConnection } from '../../backend/db/client.js';
import {
  balanceAlertSettings,
  incidents,
  maintenanceWindows,
  notificationChannels,
  notificationRoutes,
  notificationRuleRevisions,
  notificationRules,
  outboxMessages,
  silences,
  sites,
} from '../../backend/db/schema.js';
import {
  AlertEngineTransactionError,
  evaluateAlertRulesInTransaction,
} from '../../backend/services/alert-engine.js';
import { evaluateProbeAlertsInTransaction } from '../../backend/services/probe-alerts.js';
import {
  SYSTEM_EVENT_RULE_ID,
  SYSTEM_EVENT_RULE_REVISION_ID,
} from '../../backend/services/system-event-rule.js';

interface RuleInput {
  id: string;
  type: string;
  severity?: 'info' | 'warning' | 'critical';
  enabled?: boolean;
  scope?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  triggerConfirmations?: number;
  recoveryConfirmations?: number;
  channelIds?: string[];
  sendRecovery?: boolean;
}

let database: DatabaseConnection;

function addRule(input: RuleInput): { ruleId: string; revisionId: string } {
  const revisionId = `${input.id}_rev`;
  database.db.insert(notificationRules).values({
    id: input.id,
    name: input.id,
    type: input.type,
    enabled: input.enabled ?? true,
    severity: input.severity ?? 'warning',
  }).run();
  database.db.insert(notificationRuleRevisions).values({
    id: revisionId,
    ruleId: input.id,
    revisionNumber: 1,
    scopeJson: JSON.stringify(input.scope ?? {}),
    conditionJson: JSON.stringify(input.condition ?? {}),
    triggerConfirmCount: input.triggerConfirmations ?? 1,
    recoveryConfirmCount: input.recoveryConfirmations ?? 1,
    cooldownSeconds: 0,
    repeatIntervalSeconds: 0,
    maxRepeats: 0,
    sendRecovery: input.sendRecovery ?? true,
    channelIdsJson: JSON.stringify(input.channelIds ?? []),
  }).run();
  database.db.update(notificationRules).set({ currentRevisionId: revisionId })
    .where(eq(notificationRules.id, input.id)).run();
  return { ruleId: input.id, revisionId };
}

function inTransaction<T>(operation: () => T): T {
  return database.sqlite.transaction(operation).immediate();
}

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  database.db.insert(sites).values({
    id: 'site_prod',
    name: 'Production relay',
    adapterType: 'sub2api',
    baseUrl: 'https://relay.example.com',
    tagsJson: JSON.stringify(['production', 'critical-path']),
  }).run();
  for (const [id, enabled] of [
    ['channel_direct', true],
    ['channel_route', true],
    ['channel_later', true],
    ['channel_disabled', false],
  ] as const) {
    database.db.insert(notificationChannels).values({
      id,
      name: id,
      enabled,
      url: `https://${id}.example.com/hook`,
    }).run();
  }
});

afterEach(() => database.close());

describe('transactional alert engine', () => {
  it('uses the system fallback for an unmatched detail before the user rule takes ownership', () => {
    addRule({
      id: 'rule_site_details',
      type: 'site_health',
      condition: { event_types: ['site.timeout', 'site.recovered'] },
      channelIds: ['channel_direct'],
    });

    const ignored = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:00:00Z',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Connection refused',
    }));
    expect(ignored.incidentIds).toHaveLength(1);
    expect(ignored.evaluations.find(({ ruleId }) => ruleId === SYSTEM_EVENT_RULE_ID)).toMatchObject({
      ruleRevisionId: SYSTEM_EVENT_RULE_REVISION_ID,
      eventType: 'site.network_unreachable',
      state: 'firing',
    });
    expect(database.db.select().from(outboxMessages).all()).toEqual([]);
    const fallbackIncidentId = ignored.incidentIds[0]!;

    const firing = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:01:00Z',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: '连接目标站点超时',
    }));
    expect(firing.evaluations[0]).toMatchObject({ eventType: 'site.timeout', state: 'firing' });
    const userIncidentId = firing.evaluations.find(({ ruleId }) => ruleId === 'rule_site_details')?.incidentId;
    expect(userIncidentId).toBeTruthy();
    expect(database.db.select().from(incidents).where(eq(incidents.id, fallbackIncidentId)).get()).toMatchObject({
      state: 'suppressed',
      activeFingerprint: null,
      suppressedByIncidentId: userIncidentId,
      suppressionReason: 'system_fallback_replaced',
    });
    expect(JSON.parse(database.db.select().from(outboxMessages).get()!.payloadJson))
      .toMatchObject({ event: 'site.timeout', notification_kind: 'trigger' });

    const recovered = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'healthy',
      observedAt: '2026-07-14T00:02:00Z',
    }));
    expect(recovered.evaluations[0]).toMatchObject({ eventType: 'site.recovered', state: 'resolved' });
    const payloads = database.db.select().from(outboxMessages).orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => JSON.parse(row.payloadJson) as { event: string; notification_kind: string });
    expect(payloads).toEqual([
      expect.objectContaining({ event: 'site.timeout', notification_kind: 'trigger' }),
      expect.objectContaining({ event: 'site.recovered', notification_kind: 'recovery' }),
    ]);
  });

  it('links unreachable dependent monitors to the active connectivity root and suppresses duplicate notifications', () => {
    const { revisionId } = addRule({
      id: 'rule_connectivity_root',
      type: 'monitor_events',
      condition: {
        event_types: ['site.timeout', 'site.network_unreachable', 'site.recovered'],
      },
      channelIds: ['channel_direct'],
    });

    const rootResult = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:10:00Z',
      resourceKey: 'site',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Upstream request timed out',
    }));
    const rootIncidentId = rootResult.evaluations.find(({ ruleId }) => ruleId === 'rule_connectivity_root')?.incidentId;
    expect(rootIncidentId).toBeTruthy();
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);

    const dependentResult = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:11:00Z',
      resourceKey: 'monitor:balance',
      probeKind: 'balance',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Upstream request timed out',
      details: { monitor_type: 'balance' },
    }));
    expect(dependentResult.evaluations.find(({ ruleId }) => ruleId === 'rule_connectivity_root')).toMatchObject({
      eventType: 'site.timeout',
      state: 'firing',
      notifications: [],
      outboxMessageIds: [],
    });
    const dependent = database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.resourceKey, 'monitor:balance'),
    )).get();
    expect(dependent).toMatchObject({
      suppressedByIncidentId: rootIncidentId,
      suppressionReason: 'root_cause_dependency',
      triggerCount: 1,
    });
    expect(JSON.parse(dependent!.detailsJson)).toMatchObject({
      monitor_type: 'balance',
      error_code: 'UPSTREAM_UNREACHABLE',
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);

    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:12:00Z',
      resourceKey: 'monitor:balance',
      probeKind: 'balance',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Connection refused',
    }));
    expect(database.db.select().from(incidents).where(eq(incidents.id, dependent!.id)).get()).toMatchObject({
      triggerCount: 2,
      lastObservedAt: '2026-07-14T00:12:00.000Z',
      suppressedByIncidentId: rootIncidentId,
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);

    const recovery = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'healthy',
      observedAt: '2026-07-14T00:13:00Z',
      resourceKey: 'site',
    }));
    expect(recovery.evaluations.find(({ ruleId }) => ruleId === 'rule_connectivity_root')).toMatchObject({
      eventType: 'site.recovered',
      state: 'resolved',
    });
    expect(database.db.select().from(incidents).where(eq(incidents.id, dependent!.id)).get()).toMatchObject({
      state: 'resolved',
      activeFingerprint: null,
      resolvedAt: '2026-07-14T00:13:00.000Z',
      suppressedByIncidentId: rootIncidentId,
      suppressionReason: 'root_cause_dependency',
    });
    expect(database.db.select().from(incidents).where(eq(incidents.id, rootIncidentId!)).get()).toMatchObject({
      state: 'resolved',
      eventType: 'site.timeout',
    });
    const payloads = database.db.select().from(outboxMessages).orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => JSON.parse(row.payloadJson) as { event: string; notification_kind: string });
    expect(payloads).toEqual([
      expect.objectContaining({ event: 'site.timeout', notification_kind: 'trigger' }),
      expect.objectContaining({ event: 'site.recovered', notification_kind: 'recovery' }),
    ]);
  });

  it('resolves linked dependencies when an active root returns to normal', () => {
    const { revisionId } = addRule({
      id: 'rule_pending_root',
      type: 'monitor_events',
      condition: { event_types: ['site.timeout', 'site.recovered'] },
      triggerConfirmations: 2,
      recoveryConfirmations: 1,
      channelIds: ['channel_direct'],
    });
    const root = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:14:00Z',
      resourceKey: 'site',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    })).evaluations.find(({ ruleId }) => ruleId === 'rule_pending_root');
    expect(root).toMatchObject({ state: 'firing', eventType: 'site.timeout' });

    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:15:00Z',
      resourceKey: 'monitor:rates',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    }));
    const dependent = database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.resourceKey, 'monitor:rates'),
    )).get();
    expect(dependent).toMatchObject({
      state: 'firing',
      suppressedByIncidentId: root?.incidentId,
      suppressionReason: 'root_cause_dependency',
    });

    const recovered = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'healthy',
      observedAt: '2026-07-14T00:16:00Z',
      resourceKey: 'site',
    })).evaluations.find(({ ruleId }) => ruleId === 'rule_pending_root');
    expect(recovered).toMatchObject({ state: 'resolved', eventType: 'site.recovered' });
    expect(database.db.select().from(incidents).where(eq(incidents.id, dependent!.id)).get()).toMatchObject({
      state: 'resolved',
      activeFingerprint: null,
      resolvedAt: '2026-07-14T00:16:00.000Z',
      suppressedByIncidentId: root?.incidentId,
    });
    const notifications = database.db.select().from(outboxMessages).all()
      .map((row) => JSON.parse(row.payloadJson) as { notification_kind: string });
    expect(notifications.map(({ notification_kind }) => notification_kind)).toEqual(['trigger', 'recovery']);
  });

  it('recognizes legacy active roots from their latest unreachable details', () => {
    const { revisionId } = addRule({
      id: 'rule_legacy_root',
      type: 'monitor_events',
      condition: { event_types: ['site.timeout'] },
      channelIds: ['channel_direct'],
    });
    const root = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:17:00Z',
      resourceKey: 'site',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    })).evaluations.find(({ ruleId }) => ruleId === 'rule_legacy_root');
    database.db.update(incidents).set({ eventType: 'site.other_error' })
      .where(eq(incidents.id, root!.incidentId!)).run();

    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:18:00Z',
      resourceKey: 'auth',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    }));
    expect(database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.resourceKey, 'auth'),
    )).get()).toMatchObject({
      suppressedByIncidentId: root?.incidentId,
      suppressionReason: 'root_cause_dependency',
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);
  });

  it('does not trust a stale network event label when the latest root details changed error family', () => {
    const { revisionId } = addRule({
      id: 'rule_stale_root_label',
      type: 'monitor_events',
      condition: { event_types: ['site.timeout', 'site.upstream_5xx'] },
      channelIds: ['channel_direct'],
    });
    const root = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:18:30Z',
      resourceKey: 'site',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    })).evaluations.find(({ ruleId }) => ruleId === 'rule_stale_root_label');
    database.db.update(incidents).set({
      eventType: 'site.timeout',
      detailsJson: JSON.stringify({
        kind: 'health',
        status: 'degraded',
        error_code: 'UPSTREAM_SERVER_ERROR',
        error_message: 'Bad gateway',
      }),
    }).where(eq(incidents.id, root!.incidentId!)).run();

    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:19:00Z',
      resourceKey: 'monitor:balance',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    }));
    expect(database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.resourceKey, 'monitor:balance'),
    )).get()).toMatchObject({
      suppressedByIncidentId: null,
      suppressionReason: null,
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('does not root-cause suppress unrelated dependent failures', () => {
    addRule({
      id: 'rule_strict_root_cause',
      type: 'monitor_events',
      condition: {
        event_types: ['site.timeout', 'site.upstream_5xx', 'site.other_error'],
      },
      channelIds: ['channel_direct'],
    });
    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:20:00Z',
      resourceKey: 'site',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Upstream request timed out',
    }));

    for (const [resourceKey, errorCode, httpStatus] of [
      ['monitor:rates', 'UPSTREAM_SERVER_ERROR', 502],
      ['auth', 'MONITOR_RUN_FAILED', null],
    ] as const) {
      inTransaction(() => evaluateAlertRulesInTransaction(database, {
        kind: 'health',
        siteId: 'site_prod',
        status: 'degraded',
        observedAt: resourceKey === 'auth' ? '2026-07-14T00:22:00Z' : '2026-07-14T00:21:00Z',
        resourceKey,
        errorCode,
        errorMessage: 'Independent failure',
        details: { http_status: httpStatus },
      }));
    }

    const dependentIncidents = database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, 'rule_strict_root_cause_rev'),
      inArray(incidents.resourceKey, ['monitor:rates', 'auth']),
    )).all();
    expect(dependentIncidents).toHaveLength(2);
    expect(dependentIncidents.every(({ suppressedByIncidentId, suppressionReason }) =>
      suppressedByIncidentId === null && suppressionReason === null
    )).toBe(true);
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(3);
  });

  it('never links a dependent failure to another site root', () => {
    const { revisionId } = addRule({
      id: 'rule_site_isolated_root',
      type: 'monitor_events',
      condition: { event_types: ['site.timeout'] },
      channelIds: ['channel_direct'],
    });
    database.db.insert(sites).values({
      id: 'site_other',
      name: 'Other relay',
      adapterType: 'sub2api',
      baseUrl: 'https://other.example.com',
      tagsJson: '[]',
    }).run();
    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:23:00Z',
      resourceKey: 'site',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    }));
    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_other',
      status: 'down',
      observedAt: '2026-07-14T00:24:00Z',
      resourceKey: 'monitor:balance',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
    }));

    expect(database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.siteId, 'site_other'),
      eq(incidents.resourceKey, 'monitor:balance'),
    )).get()).toMatchObject({
      suppressedByIncidentId: null,
      suppressionReason: null,
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('classifies added rates and filters other change types', () => {
    addRule({
      id: 'rule_rate_added',
      type: 'rate_changed',
      condition: { event_types: ['rate.added'] },
      channelIds: ['channel_direct'],
    });
    const added = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: 'site_prod',
      observedAt: '2026-07-14T00:00:00Z',
      rateKey: 'group:added',
      value: '0.8',
      previousValue: null,
      changed: true,
      changeType: 'added',
    }));
    expect(added.evaluations[0]).toMatchObject({ eventType: 'rate.added', state: 'resolved' });

    const changed = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: 'site_prod',
      observedAt: '2026-07-14T00:01:00Z',
      rateKey: 'group:changed',
      value: '0.9',
      previousValue: '0.8',
      changed: true,
      changeType: 'value_changed',
    }));
    expect(changed.incidentIds).toHaveLength(1);
    expect(changed.evaluations.find(({ ruleId }) => ruleId === SYSTEM_EVENT_RULE_ID)).toMatchObject({
      eventType: 'rate.changed',
      state: 'resolved',
    });
    expect(changed.outboxMessageIds).toEqual([]);
  });

  it('evaluates site, rate, and probe observations with one monitor event rule', () => {
    addRule({
      id: 'rule_monitor_events',
      type: 'monitor_events',
      condition: {
        event_types: ['site.timeout', 'site.recovered', 'rate.added', 'probe.failed', 'probe.recovered'],
      },
      channelIds: ['channel_direct'],
    });

    const siteResult = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:00:00Z',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Upstream request timed out',
    }));
    expect(siteResult.evaluations[0]).toMatchObject({ eventType: 'site.timeout', state: 'firing' });

    const rateResult = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: 'site_prod',
      observedAt: '2026-07-14T00:01:00Z',
      rateKey: 'group:added',
      value: '0.8',
      previousValue: null,
      changed: true,
      changeType: 'added',
    }));
    expect(rateResult.evaluations[0]).toMatchObject({ eventType: 'rate.added', state: 'resolved' });

    const probeResult = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: 'site_prod',
      observedAt: '2026-07-14T00:02:00Z',
      rateKey: 'group:probe',
      value: null,
      eventType: 'probe.failed',
      violating: true,
    }));
    expect(probeResult.evaluations[0]).toMatchObject({ eventType: 'probe.failed', state: 'firing' });
    expect(database.db.select().from(incidents).all()).toHaveLength(3);
  });

  it('bridges probe failure and recovery through the existing alert state machine', () => {
    addRule({
      id: 'rule_probe',
      type: 'rate_changed',
      condition: { event_types: ['probe.failed', 'probe.recovered'] },
      channelIds: ['channel_direct'],
    });
    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:1:effective',
      rateKind: 'group',
      rateName: 'GPT Group',
      observedAt: '2026-07-14T00:00:00Z',
      requestedModel: 'gpt-5.6-sol',
      status: 'failed',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'timeout',
    }));
    expect(database.db.select().from(incidents).get()).toMatchObject({
      eventType: 'probe.failed',
      state: 'firing',
    });

    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:1:effective',
      rateKind: 'group',
      rateName: 'GPT Group',
      observedAt: '2026-07-14T00:01:00Z',
      requestedModel: 'gpt-5.6-sol',
      status: 'success',
      inputTokenAssessment: 'within_expected',
      toolCallsObserved: false,
      promptIntegrity: 'no_interference_observed',
      modelIdentity: 'declared_match',
    }));
    expect(database.db.select().from(incidents).get()).toMatchObject({ state: 'resolved' });
    const payloads = database.db.select().from(outboxMessages).orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => JSON.parse(row.payloadJson) as {
        event: string;
        incident: { summary: string };
        site: { name: string };
      });
    expect(payloads.map(({ event }) => event)).toEqual(['probe.failed', 'probe.recovered']);
    expect(payloads.map(({ incident }) => incident.summary)).toEqual([
      'Production relay · GPT Group · 模型实测失败',
      'Production relay · GPT Group · 模型实测已恢复',
    ]);
    expect(payloads.every(({ site }) => site.name === 'Production relay')).toBe(true);
  });

  it('merges findings from one probe notification while retaining independent incidents', () => {
    addRule({
      id: 'rule_probe_findings',
      type: 'monitor_events',
      condition: {
        event_types: ['probe.input_tokens_high', 'probe.prompt_interference'],
      },
      channelIds: ['channel_direct'],
    });

    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:1:effective',
      rateKind: 'group',
      rateName: 'ChatGPT-Pro 高并发通道',
      observedAt: '2026-07-14T00:00:00Z',
      requestedModel: 'gpt-5.6-sol',
      status: 'success',
      inputTokenAssessment: 'higher_than_expected',
      toolCallsObserved: false,
      promptIntegrity: 'suspected',
      modelIdentity: 'declared_match',
      reportedInputTokens: 4_484,
      expectedInputTokens: 83,
      inputTokenDelta: 4_401,
    }));

    const userIncidents = database.db.select().from(incidents)
      .where(eq(incidents.ruleRevisionId, 'rule_probe_findings_rev'))
      .orderBy(asc(incidents.eventType)).all();
    expect(userIncidents).toHaveLength(2);
    expect(userIncidents.map(({ eventType, summary }) => ({ eventType, summary }))).toEqual([
      {
        eventType: 'probe.input_tokens_high',
        summary: 'Production relay · ChatGPT-Pro 高并发通道 · 输入 Token 高于客户端字符粗估',
      },
      {
        eventType: 'probe.prompt_interference',
        summary: 'Production relay · ChatGPT-Pro 高并发通道 · 疑似存在提示词干扰',
      },
    ]);
    const triggerRows = database.db.select().from(outboxMessages).all();
    expect(triggerRows).toHaveLength(1);
    expect(JSON.parse(triggerRows[0]!.payloadJson)).toMatchObject({
      event: 'probe.input_tokens_high',
      event_types: ['probe.input_tokens_high', 'probe.prompt_interference'],
      notification_kind: 'trigger',
      incident: {
        summary: 'Production relay · ChatGPT-Pro 高并发通道 · 模型实测发现 2 项异常：输入 Token 高于客户端字符粗估；疑似存在提示词干扰',
      },
      incidents: [
        { event: 'probe.input_tokens_high' },
        { event: 'probe.prompt_interference' },
      ],
      details: { probe_notification_merged: true },
    });

    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:1:effective',
      rateKind: 'group',
      rateName: 'ChatGPT-Pro 高并发通道',
      observedAt: '2026-07-14T00:01:00Z',
      requestedModel: 'gpt-5.6-sol',
      status: 'success',
      inputTokenAssessment: 'within_expected',
      toolCallsObserved: false,
      promptIntegrity: 'no_interference_observed',
      modelIdentity: 'declared_match',
    }));

    expect(database.db.select().from(incidents)
      .where(eq(incidents.ruleRevisionId, 'rule_probe_findings_rev')).all()
      .every(({ state }) => state === 'resolved')).toBe(true);
    const payloads = database.db.select().from(outboxMessages)
      .orderBy(asc(outboxMessages.createdAt)).all()
      .map(({ payloadJson }) => JSON.parse(payloadJson));
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({
      notification_kind: 'recovery',
      event_types: ['probe.input_tokens_high', 'probe.prompt_interference'],
      incident: {
        summary: 'Production relay · ChatGPT-Pro 高并发通道 · 模型实测有 2 项异常已恢复：输入 Token 高于客户端字符粗估；疑似存在提示词干扰',
      },
    });
  });

  it('does not include findings excluded by the rule in a probe notification', () => {
    addRule({
      id: 'rule_probe_input_only',
      type: 'monitor_events',
      condition: { event_types: ['probe.input_tokens_high'] },
      channelIds: ['channel_direct'],
    });

    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:restricted',
      rateName: 'Restricted Group',
      observedAt: '2026-07-14T00:00:00Z',
      requestedModel: 'gpt-test',
      status: 'success',
      inputTokenAssessment: 'higher_than_expected',
      promptIntegrity: 'suspected',
      modelIdentity: 'declared_match',
    }));

    const rows = database.db.select().from(outboxMessages).all();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.event).toBe('probe.input_tokens_high');
    expect(payload).not.toHaveProperty('event_types');
    expect(rows[0]!.payloadJson).not.toContain('probe.prompt_interference');
    expect(rows[0]!.payloadJson).not.toContain('疑似存在提示词干扰');
    expect(database.db.select().from(incidents).all()
      .map(({ eventType }) => eventType)).toEqual(expect.arrayContaining([
        'probe.input_tokens_high',
        'probe.prompt_interference',
      ]));
  });

  it('keeps probe notification aggregation inside each rule revision and channel', () => {
    addRule({
      id: 'rule_probe_multi_channel',
      type: 'monitor_events',
      condition: { event_types: ['probe.input_tokens_high', 'probe.prompt_interference'] },
      channelIds: ['channel_direct', 'channel_later'],
    });
    addRule({
      id: 'rule_probe_second',
      type: 'monitor_events',
      condition: { event_types: ['probe.input_tokens_high', 'probe.prompt_interference'] },
      channelIds: ['channel_direct'],
    });

    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:boundaries',
      rateName: 'Boundary Group',
      observedAt: '2026-07-14T00:00:00Z',
      requestedModel: 'gpt-test',
      status: 'success',
      inputTokenAssessment: 'higher_than_expected',
      promptIntegrity: 'suspected',
      modelIdentity: 'declared_match',
    }));

    const rows = database.db.select().from(outboxMessages).all();
    expect(rows).toHaveLength(3);
    expect(rows.filter(({ channelId }) => channelId === 'channel_direct')).toHaveLength(2);
    expect(rows.filter(({ channelId }) => channelId === 'channel_later')).toHaveLength(1);
    expect(rows.map(({ payloadJson }) => JSON.parse(payloadJson))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_types: ['probe.input_tokens_high', 'probe.prompt_interference'],
        rule: expect.objectContaining({ id: 'rule_probe_multi_channel' }),
      }),
      expect.objectContaining({
        event_types: ['probe.input_tokens_high', 'probe.prompt_interference'],
        rule: expect.objectContaining({ id: 'rule_probe_second' }),
      }),
    ]));
  });

  it('uses a recovery summary when one probe finding clears', () => {
    addRule({
      id: 'rule_probe_single_recovery',
      type: 'monitor_events',
      condition: { event_types: ['probe.input_tokens_high'] },
      channelIds: ['channel_direct'],
    });
    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:single-recovery',
      rateName: 'Single Recovery Group',
      observedAt: '2026-07-14T00:00:00Z',
      requestedModel: 'gpt-test',
      status: 'success',
      inputTokenAssessment: 'higher_than_expected',
      promptIntegrity: 'no_interference_observed',
      modelIdentity: 'declared_match',
    }));
    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:single-recovery',
      rateName: 'Single Recovery Group',
      observedAt: '2026-07-14T00:01:00Z',
      requestedModel: 'gpt-test',
      status: 'success',
      inputTokenAssessment: 'within_expected',
      promptIntegrity: 'no_interference_observed',
      modelIdentity: 'declared_match',
    }));

    const userIncident = database.db.select().from(incidents)
      .where(eq(incidents.ruleRevisionId, 'rule_probe_single_recovery_rev')).get();
    expect(userIncident).toMatchObject({
      state: 'resolved',
      summary: 'Production relay · Single Recovery Group · 输入 Token 异常已恢复',
    });
    const payloads = database.db.select().from(outboxMessages)
      .orderBy(asc(outboxMessages.createdAt)).all()
      .map(({ payloadJson }) => JSON.parse(payloadJson) as {
        notification_kind: string;
        incident: { summary: string };
      });
    expect(payloads[1]).toMatchObject({
      notification_kind: 'recovery',
      incident: {
        summary: 'Production relay · Single Recovery Group · 输入 Token 异常已恢复',
      },
    });
  });

  it('does not merge a recovered probe finding with a newly triggered finding', () => {
    addRule({
      id: 'rule_probe_mixed_transition',
      type: 'monitor_events',
      condition: { event_types: ['probe.input_tokens_high', 'probe.prompt_interference'] },
      channelIds: ['channel_direct'],
    });
    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:mixed',
      rateName: 'Mixed Group',
      observedAt: '2026-07-14T00:00:00Z',
      requestedModel: 'gpt-test',
      status: 'success',
      inputTokenAssessment: 'higher_than_expected',
      promptIntegrity: 'no_interference_observed',
      modelIdentity: 'declared_match',
    }));
    inTransaction(() => evaluateProbeAlertsInTransaction(database, {
      siteId: 'site_prod',
      rateKey: 'group:mixed',
      rateName: 'Mixed Group',
      observedAt: '2026-07-14T00:01:00Z',
      requestedModel: 'gpt-test',
      status: 'success',
      inputTokenAssessment: 'within_expected',
      promptIntegrity: 'suspected',
      modelIdentity: 'declared_match',
    }));

    const transitions = database.db.select().from(outboxMessages)
      .orderBy(asc(outboxMessages.createdAt)).all()
      .map(({ payloadJson }) => JSON.parse(payloadJson) as {
        event: string;
        notification_kind: string;
      });
    expect(transitions).toHaveLength(3);
    expect(transitions.slice(1)
      .map(({ event, notification_kind }) => ({ event, notification_kind }))
      .sort((left, right) => left.event.localeCompare(right.event))).toEqual([
      { event: 'probe.input_tokens_high', notification_kind: 'recovery' },
      { event: 'probe.prompt_interference', notification_kind: 'trigger' },
    ]);
  });

  it('digests same-site task recoveries within the rule window without merging incidents', () => {
    addRule({
      id: 'rule_recovery_digest',
      type: 'monitor_events',
      condition: { event_types: ['site.upstream_5xx', 'site.recovered'] },
      channelIds: ['channel_direct'],
    });

    for (const [resourceKey, probeKind] of [
      ['monitor:rates', 'rates'],
      ['site', 'user_api'],
    ] as const) {
      inTransaction(() => evaluateAlertRulesInTransaction(database, {
        kind: 'health',
        siteId: 'site_prod',
        resourceKey,
        probeKind,
        status: 'degraded',
        observedAt: '2026-07-14T00:00:00Z',
        errorCode: 'UPSTREAM_SERVER_ERROR',
      }));
    }

    const firstRecovery = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      resourceKey: 'monitor:rates',
      probeKind: 'rates',
      status: 'healthy',
      observedAt: '2026-07-14T00:01:00Z',
    }));
    const digestedRecovery = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      resourceKey: 'site',
      probeKind: 'user_api',
      status: 'healthy',
      observedAt: '2026-07-14T00:01:10Z',
    }));

    expect(firstRecovery.evaluations.find(({ ruleId }) => ruleId === 'rule_recovery_digest')?.notifications)
      .toEqual([{ kind: 'recovery', occurredAt: '2026-07-14T00:01:00.000Z' }]);
    expect(digestedRecovery.evaluations.find(({ ruleId }) => ruleId === 'rule_recovery_digest')?.notifications)
      .toEqual([]);
    const userIncidents = database.db.select().from(incidents)
      .where(eq(incidents.ruleRevisionId, 'rule_recovery_digest_rev')).all();
    expect(userIncidents).toHaveLength(2);
    expect(userIncidents.every(({ state }) => state === 'resolved')).toBe(true);
    const recoveries = database.db.select().from(outboxMessages).all()
      .map((row) => JSON.parse(row.payloadJson) as { event: string; incident: { summary: string } })
      .filter(({ event }) => event === 'site.recovered');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({
      incident: { summary: 'Production relay · 倍率监控已恢复。' },
    });
  });

  it('requires a caller-owned transaction', () => {
    addRule({ id: 'rule_health', type: 'site_down' });
    expect(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:00:00Z',
    })).toThrow(AlertEngineTransactionError);
    expect(database.db.select().from(incidents).all()).toEqual([]);
  });

  it('rolls incident and outbox writes back with the caller transaction', () => {
    addRule({
      id: 'rule_health',
      type: 'site_down',
      channelIds: ['channel_direct'],
    });
    expect(() => inTransaction(() => {
      evaluateAlertRulesInTransaction(database, {
        kind: 'health',
        siteId: 'site_prod',
        status: 'down',
        observedAt: '2026-07-14T00:00:00Z',
      });
      throw new Error('simulate failure before commit');
    })).toThrow('simulate failure');
    expect(database.db.select().from(incidents).all()).toEqual([]);
    expect(database.db.select().from(outboxMessages).all()).toEqual([]);
  });

  it('ignores legacy routes when a rule has no directly bound channels', () => {
    addRule({ id: 'rule_without_channels', type: 'site_down' });
    database.db.insert(notificationRoutes).values({
      id: 'legacy_route',
      name: 'Legacy route',
      enabled: true,
      matcherJson: '{}',
      channelIdsJson: JSON.stringify(['channel_route']),
    }).run();

    const result = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T00:00:00Z',
    }));

    expect(result.evaluations[0]).toMatchObject({ state: 'firing' });
    expect(result.outboxMessageIds).toEqual([]);
    expect(database.db.select().from(outboxMessages).all()).toEqual([]);
  });

  it('fires a balance alert immediately, confirms recovery, and queues only rule-bound channels', () => {
    addRule({
      id: 'rule_balance',
      type: 'balance_low',
      scope: { site_ids: ['site_prod'], tags: ['production'], balance_keys: [] },
      condition: {
        balance_key: 'cash:primary',
        operator: '<',
        threshold: '10.00000000000000000000',
        recovery_threshold: '12',
      },
      triggerConfirmations: 2,
      recoveryConfirmations: 2,
      channelIds: ['channel_direct', 'channel_route', 'channel_direct', 'channel_disabled'],
    });

    const observe = (value: string, minute: number) => inTransaction(() =>
      evaluateAlertRulesInTransaction(database, {
        kind: 'balance',
        siteId: 'site_prod',
        balanceKey: 'cash:primary',
        balanceKind: 'cash',
        value,
        unit: 'CNY',
        observedAt: `2026-07-14T00:0${minute}:00Z`,
      }));

    const firing = observe('9.99999999999999999999', 0);
    expect(firing.evaluations[0]?.notifications.map(({ kind }) => kind)).toEqual(['trigger']);
    expect(firing.outboxMessageIds).toHaveLength(2);
    const triggeredRows = database.db.select().from(outboxMessages)
      .orderBy(asc(outboxMessages.channelId)).all();
    expect(triggeredRows.map(({ channelId }) => channelId)).toEqual(['channel_direct', 'channel_route']);
    expect(new Set(triggeredRows.map(({ eventId }) => eventId)).size).toBe(1);
    expect(triggeredRows.every(({ state }) => state === 'pending')).toBe(true);

    const repeatedObservation = observe('9.99999999999999999999', 1);
    expect(repeatedObservation.evaluations[0]).toMatchObject({ state: 'firing', violating: true });
    expect(repeatedObservation.outboxMessageIds).toEqual([]);

    const hysteresis = observe('11', 2);
    expect(hysteresis.evaluations[0]).toMatchObject({ state: 'firing', violating: true });
    expect(observe('12', 3).evaluations[0]).toMatchObject({ state: 'recovering', violating: false });
    const resolved = observe('12.0000', 4);
    expect(resolved.evaluations[0]?.notifications.map(({ kind }) => kind)).toEqual(['recovery']);
    expect(resolved.outboxMessageIds).toHaveLength(2);

    const incident = database.db.select().from(incidents).get();
    expect(incident).toMatchObject({
      state: 'resolved',
      activeFingerprint: null,
      triggerCount: 0,
      recoveryCount: 2,
    });
    expect(JSON.parse(incident!.detailsJson)).toMatchObject({ value: '12', balance_key: 'cash:primary' });
  });

  it('uses the global low-balance threshold for unified monitor event rules', () => {
    database.db.update(balanceAlertSettings).set({ enabled: true, threshold: '10' })
      .where(eq(balanceAlertSettings.id, 'global')).run();
    addRule({
      id: 'rule_global_balance',
      type: 'monitor_events',
      condition: { event_types: ['balance.low'] },
      recoveryConfirmations: 1,
      channelIds: ['channel_direct'],
    });

    const low = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'balance',
      siteId: 'site_prod',
      balanceKey: 'cash:primary',
      balanceKind: 'cash',
      value: '9.99',
      unit: 'USD',
      observedAt: '2026-07-14T00:10:00Z',
    }));
    expect(low.evaluations[0]).toMatchObject({ eventType: 'balance.low', state: 'firing', violating: true });
    expect(database.db.select().from(incidents).get()?.summary).toContain('小于 10');

    const recovered = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'balance',
      siteId: 'site_prod',
      balanceKey: 'cash:primary',
      balanceKind: 'cash',
      value: '10',
      unit: 'USD',
      observedAt: '2026-07-14T00:11:00Z',
    }));
    expect(recovered.evaluations[0]).toMatchObject({ state: 'resolved', violating: false });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('evaluates only the enabled current rate revision and serializes decimal changes as strings', () => {
    const { ruleId, revisionId: firstRevisionId } = addRule({
      id: 'rule_rate',
      type: 'rate_changed',
      scope: { rate_kinds: ['group'] },
      condition: { directions: ['down'] },
      channelIds: ['channel_direct'],
    });
    const currentRevisionId = 'rule_rate_rev_2';
    database.db.insert(notificationRuleRevisions).values({
      id: currentRevisionId,
      ruleId,
      revisionNumber: 2,
      scopeJson: JSON.stringify({ rate_kinds: ['group'], platforms: ['openai'] }),
      conditionJson: JSON.stringify({ directions: ['up'], minimum_change: '0.00000000000000000002' }),
      triggerConfirmCount: 1,
      recoveryConfirmCount: 1,
      cooldownSeconds: 0,
      repeatIntervalSeconds: 0,
      maxRepeats: 0,
      channelIdsJson: JSON.stringify(['channel_direct']),
    }).run();
    database.db.update(notificationRules).set({ currentRevisionId })
      .where(eq(notificationRules.id, ruleId)).run();
    addRule({ id: 'rule_disabled', type: 'rate_changed', enabled: false, channelIds: ['channel_direct'] });

    const result = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: 'site_prod',
      rateKey: 'group:12:effective',
      rateKind: 'group',
      rateName: 'GPT Pro',
      platform: 'openai',
      comparisonKey: 'sub2api:group:openai:effective:v1',
      previousValue: '0.12000000000000000001',
      value: '0.12000000000000000003',
      observedAt: '2026-07-14T01:00:00Z',
    }));

    expect(result.matchedRuleCount).toBe(1);
    expect(result.evaluations[0]).toMatchObject({ ruleRevisionId: currentRevisionId, state: 'resolved' });
    expect(result.evaluations[0]?.ruleRevisionId).not.toBe(firstRevisionId);
    const payload = JSON.parse(database.db.select().from(outboxMessages).get()!.payloadJson);
    expect(payload.event).toBe('rate.changed');
    expect(payload.changes[0]).toMatchObject({
      old_rate: '0.12000000000000000001',
      new_rate: '0.12000000000000000003',
      direction: 'up',
    });

    const equivalent = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'rate',
      siteId: 'site_prod',
      rateKey: 'group:other:effective',
      rateKind: 'group',
      platform: 'openai',
      previousValue: '0.120',
      value: '0.12',
      observedAt: '2026-07-14T01:01:00Z',
    }));
    expect(equivalent.evaluations[0]).toMatchObject({ incidentId: null, violating: false, state: 'normal' });
  });

  it('records every rate change once without a recovery notification', () => {
    addRule({
      id: 'rule_rate_once',
      type: 'monitor_events',
      condition: { event_types: ['rate.changed'], directions: ['up', 'down'] },
      channelIds: ['channel_direct'],
      sendRecovery: true,
    });
    const observe = (previousValue: string, value: string, minute: number) => inTransaction(() =>
      evaluateAlertRulesInTransaction(database, {
        kind: 'rate',
        siteId: 'site_prod',
        rateKey: 'group:44:effective',
        rateKind: 'group',
        rateName: 'OpenAI 标准组',
        previousValue,
        value,
        changed: true,
        changeType: 'value_changed',
        observedAt: `2026-07-14T01:0${minute}:00Z`,
      }));

    expect(observe('0.02', '0.08', 0).evaluations[0]).toMatchObject({ state: 'resolved' });
    expect(observe('0.08', '0.12', 1).evaluations[0]).toMatchObject({ state: 'resolved' });
    const rows = database.db.select().from(incidents).orderBy(asc(incidents.createdAt)).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.activeFingerprint === null && row.triggerCount === 1)).toBe(true);
    expect(rows.map((row) => row.summary)).toEqual([
      'Production relay的分组“OpenAI 标准组”倍率由 0.02 变为 0.08。',
      'Production relay的分组“OpenAI 标准组”倍率由 0.08 变为 0.12。',
    ]);
    const payloads = database.db.select().from(outboxMessages).orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => JSON.parse(row.payloadJson) as { notification_kind: string; details: Record<string, unknown> });
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.notification_kind === 'trigger')).toBe(true);
    expect(payloads[0]?.details).toMatchObject({ rate_name: 'OpenAI 标准组', old_rate: '0.02', new_rate: '0.08' });
  });

  it('supports health status conditions and recovers after the configured confirmation count', () => {
    addRule({
      id: 'rule_health',
      type: 'site_down',
      condition: { statuses: ['down', 'adapter_unavailable'] },
      triggerConfirmations: 1,
      recoveryConfirmations: 2,
      channelIds: ['channel_direct'],
    });
    const observe = (status: 'healthy' | 'degraded' | 'down', minute: number) => inTransaction(() =>
      evaluateAlertRulesInTransaction(database, {
        kind: 'health',
        siteId: 'site_prod',
        status,
        observedAt: `2026-07-14T02:0${minute}:00Z`,
      }));

    expect(observe('degraded', 0).evaluations[0]).toMatchObject({ incidentId: null, violating: false });
    expect(observe('down', 1).evaluations[0]).toMatchObject({ state: 'firing', violating: true });
    expect(observe('healthy', 2).evaluations[0]).toMatchObject({ state: 'recovering', violating: false });
    expect(observe('healthy', 3).evaluations[0]).toMatchObject({ state: 'resolved', violating: false });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('keeps an authenticated user API recovery on the site connectivity incident', () => {
    addRule({
      id: 'rule_user_api_connectivity',
      type: 'monitor_events',
      condition: { event_types: ['site.timeout', 'site.recovered'] },
      recoveryConfirmations: 1,
      channelIds: ['channel_direct'],
    });
    const firing = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      resourceKey: 'site',
      probeKind: 'user_api',
      errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Request timeout',
      observedAt: '2026-07-14T02:05:00Z',
    }));
    const incidentId = firing.evaluations.find(({ ruleId }) =>
      ruleId === 'rule_user_api_connectivity'
    )?.incidentId;
    expect(incidentId).toBeTruthy();

    const recovered = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'healthy',
      authenticated: true,
      authStatus: 'authenticated',
      probeKind: 'user_api',
      observedAt: '2026-07-14T02:06:00Z',
    }));
    expect(recovered.evaluations.find(({ ruleId }) =>
      ruleId === 'rule_user_api_connectivity'
    )).toMatchObject({
      incidentId,
      resourceKey: 'site',
      eventType: 'site.recovered',
      state: 'resolved',
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('merges authentication failures from all monitor tasks into one root incident', () => {
    const { revisionId } = addRule({
      id: 'rule_auth_root',
      type: 'monitor_events',
      condition: {
        event_types: ['site.auth_expired', 'site.permission_denied', 'site.recovered'],
      },
      recoveryConfirmations: 1,
      channelIds: ['channel_direct'],
    });
    const resources = ['auth', 'site', 'monitor:balance', 'monitor:rates'] as const;
    const incidentIds = resources.map((resourceKey, index) => {
      const result = inTransaction(() => evaluateAlertRulesInTransaction(database, {
        kind: 'health',
        siteId: 'site_prod',
        status: 'degraded',
        authenticated: false,
        authStatus: 'invalid_credentials',
        resourceKey,
        probeKind: resourceKey.split(':').at(-1),
        errorCode: 'AUTH_INVALID_CREDENTIALS',
        errorMessage: 'Invalid credentials',
        details: { http_status: 401 },
        observedAt: `2026-07-14T02:1${index}:00Z`,
      }));
      const evaluation = result.evaluations.find(({ ruleId }) => ruleId === 'rule_auth_root');
      expect(evaluation).toMatchObject({
        eventType: 'site.auth_expired',
        resourceKey: 'auth',
        state: 'firing',
      });
      return evaluation!.incidentId;
    });

    expect(new Set(incidentIds).size).toBe(1);
    const active = database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.state, 'firing'),
    )).all();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      resourceKey: 'auth',
      eventType: 'site.auth_expired',
      triggerCount: 4,
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);

    const denied = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'degraded',
      authenticated: false,
      resourceKey: 'monitor:balance',
      probeKind: 'balance',
      errorCode: 'AUTH_PERMISSION_DENIED',
      errorMessage: 'Forbidden',
      details: { http_status: 403 },
      observedAt: '2026-07-14T02:14:00Z',
    }));
    expect(denied.evaluations.find(({ ruleId }) => ruleId === 'rule_auth_root')).toMatchObject({
      incidentId: incidentIds[0],
      eventType: 'site.permission_denied',
      resourceKey: 'auth',
    });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);

    const recovered = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'healthy',
      authenticated: true,
      authStatus: 'authenticated',
      eventType: 'auth.failed',
      resourceKey: 'auth',
      probeKind: 'auth',
      observedAt: '2026-07-14T02:15:00Z',
    }));
    expect(recovered.evaluations.find(({ ruleId }) => ruleId === 'rule_auth_root')).toMatchObject({
      incidentId: incidentIds[0],
      eventType: 'site.recovered',
      resourceKey: 'auth',
      state: 'resolved',
    });
    const payloads = database.db.select().from(outboxMessages).orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => JSON.parse(row.payloadJson) as { event: string; notification_kind: string });
    expect(payloads).toEqual([
      expect.objectContaining({ event: 'site.auth_expired', notification_kind: 'trigger' }),
      expect.objectContaining({ event: 'site.recovered', notification_kind: 'recovery' }),
    ]);
  });

  it('consolidates legacy active authentication incidents on the next observation', () => {
    const { revisionId } = addRule({
      id: 'rule_legacy_auth_root',
      type: 'monitor_events',
      condition: { event_types: ['site.auth_expired', 'site.permission_denied'] },
      channelIds: ['channel_direct'],
    });
    for (const [index, resourceKey] of ['auth', 'site', 'monitor:balance', 'monitor:rates'].entries()) {
      database.db.insert(incidents).values({
        id: `incident_legacy_auth_${index}`,
        ruleRevisionId: revisionId,
        siteId: 'site_prod',
        resourceKey,
        eventType: 'site.auth_expired',
        fingerprint: `legacy_auth_${index}`,
        activeFingerprint: `legacy_auth_${index}`,
        state: 'firing',
        severity: 'warning',
        summary: 'Legacy authentication failure',
        triggerCount: 1,
        firstObservedAt: `2026-07-14T02:2${index}:00.000Z`,
        firedAt: `2026-07-14T02:2${index}:00.000Z`,
        lastObservedAt: `2026-07-14T02:2${index}:00.000Z`,
        lastNotifiedAt: `2026-07-14T02:2${index}:00.000Z`,
      }).run();
    }

    const result = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'degraded',
      authenticated: false,
      authStatus: 'invalid_credentials',
      resourceKey: 'monitor:rates',
      probeKind: 'rates',
      errorCode: 'AUTH_INVALID_CREDENTIALS',
      observedAt: '2026-07-14T02:24:00Z',
    }));
    const evaluation = result.evaluations.find(({ ruleId }) => ruleId === 'rule_legacy_auth_root');
    expect(evaluation).toMatchObject({
      incidentId: 'incident_legacy_auth_0',
      resourceKey: 'auth',
      state: 'firing',
      notifications: [],
    });
    expect(database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.state, 'firing'),
    )).all()).toEqual([
      expect.objectContaining({
        id: 'incident_legacy_auth_0',
        resourceKey: 'auth',
        triggerCount: 2,
      }),
    ]);
    const merged = database.db.select().from(incidents).where(and(
      eq(incidents.ruleRevisionId, revisionId),
      eq(incidents.state, 'suppressed'),
    )).all();
    expect(merged).toHaveLength(3);
    expect(merged.every(({ suppressedByIncidentId, suppressionReason }) =>
      suppressedByIncidentId === 'incident_legacy_auth_0'
      && suppressionReason === 'auth_root_cause_merged'
    )).toBe(true);
    expect(database.db.select().from(outboxMessages).all()).toEqual([]);
  });

  it('maps authentication failures and recovery to detailed site events', () => {
    addRule({
      id: 'rule_auth',
      type: 'auth_failed',
      triggerConfirmations: 1,
      recoveryConfirmations: 1,
      channelIds: ['channel_direct'],
    });
    const firing = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'degraded',
      authenticated: false,
      authStatus: 'invalid_credentials',
      errorCode: 'AUTH_INVALID_CREDENTIALS',
      observedAt: '2026-07-14T02:10:00Z',
    }));
    expect(firing.evaluations[0]).toMatchObject({
      eventType: 'site.auth_expired',
      resourceKey: 'auth',
      violating: true,
      state: 'firing',
    });
    const incident = database.db.select().from(incidents).get();
    expect(JSON.parse(incident!.detailsJson)).toMatchObject({
      authenticated: false,
      auth_status: 'invalid_credentials',
      error_code: 'AUTH_INVALID_CREDENTIALS',
    });

    const recovered = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'healthy',
      authenticated: true,
      authStatus: 'authenticated',
      observedAt: '2026-07-14T02:11:00Z',
    }));
    expect(recovered.evaluations[0]).toMatchObject({ state: 'resolved', violating: false });
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(2);
    const events = database.db.select().from(outboxMessages).orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => (JSON.parse(row.payloadJson) as { event: string }).event);
    expect(events).toEqual(['site.auth_expired', 'site.recovered']);
  });

  it('suppresses notifications during matching maintenance and silence windows unless explicitly overridden', () => {
    addRule({
      id: 'rule_health',
      type: 'site_down',
      triggerConfirmations: 1,
      channelIds: ['channel_direct'],
    });
    database.db.insert(maintenanceWindows).values({
      id: 'maintenance_prod',
      name: 'production maintenance',
      enabled: true,
      kind: 'once',
      matcherJson: JSON.stringify({ site_ids: ['site_prod'] }),
      startsAt: '2026-07-14T04:00:00Z',
      endsAt: '2026-07-14T05:00:00Z',
      timezone: 'UTC',
    }).run();
    const suppressed = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T04:10:00Z',
    }));
    expect(suppressed.evaluations[0]).toMatchObject({ state: 'firing', notifications: [] });
    expect(database.db.select().from(incidents).get()?.suppressionReason).toBe('maintenance:maintenance_prod');
    expect(database.db.select().from(outboxMessages).all()).toEqual([]);

    const afterMaintenance = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T05:01:00Z',
    }));
    expect(afterMaintenance.evaluations[0]?.notifications.map(({ kind }) => kind)).toEqual(['trigger']);
    expect(database.db.select().from(outboxMessages).all()).toHaveLength(1);

    database.db.insert(silences).values({
      id: 'silence_prod',
      matcherJson: JSON.stringify({
        site_ids: ['site_prod'],
        tags: ['production'],
        event_types: ['site.network_unreachable'],
        severities: ['warning'],
      }),
      reason: 'operator requested',
      startsAt: '2026-07-14T05:02:00Z',
      endsAt: '2026-07-14T06:00:00Z',
    }).run();
    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T05:05:00Z',
    }));
    expect(database.db.select().from(incidents).get()?.suppressionReason).toBe('silence:silence_prod');
    const explicitlyAllowed = inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      notificationsAllowed: true,
      observedAt: '2026-07-14T05:10:00Z',
    }));
    expect(explicitlyAllowed.evaluations[0]?.state).toBe('firing');
    expect(database.db.select().from(incidents).get()?.suppressionReason).toBeNull();
  });

  it('keeps separate incidents for different rules over the same resource', () => {
    addRule({ id: 'rule_a', type: 'site_down' });
    addRule({ id: 'rule_b', type: 'site_down' });
    inTransaction(() => evaluateAlertRulesInTransaction(database, {
      kind: 'health',
      siteId: 'site_prod',
      status: 'down',
      observedAt: '2026-07-14T03:00:00Z',
    }));
    const active = database.db.select().from(incidents)
      .where(and(eq(incidents.siteId, 'site_prod'), eq(incidents.state, 'firing'))).all();
    expect(active).toHaveLength(2);
    expect(new Set(active.map(({ fingerprint }) => fingerprint)).size).toBe(2);
  });
});
