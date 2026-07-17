import { randomBytes } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AdapterRegistry,
  type AuthResult,
  type HealthResult,
  type NormalizedBalance,
  type NormalizedRateSnapshot,
  type RelayAdapter,
} from '../../backend/adapters/index.js';
import type { AppContext } from '../../backend/context.js';
import { CredentialVault } from '../../backend/core/vault.js';
import {
  balanceSnapshots,
  healthChecks,
  incidents,
  monitorConfigs,
  notificationChannels,
  notificationRuleRevisions,
  notificationRules,
  openDatabase,
  outboxMessages,
  rateHistory,
  rateProbeRuns,
  ratesCurrent,
  sites,
} from '../../backend/db/index.js';
import { runMonitor } from '../../backend/services/monitor-runner.js';
import { storeCredentials } from '../../backend/services/credentials.js';

class FakeAlertAdapter implements RelayAdapter {
  readonly credentialSchema = z.object({
    mode: z.enum(['password', 'token']),
    values: z.object({ access_token: z.string().optional() }).strict(),
  });

  authInput: unknown = null;

  health: HealthResult = {
    status: 'healthy',
    probeKind: 'model_api',
    authenticated: null,
    latencyMs: 20,
    checkedAt: '2026-07-14T00:00:00.000Z',
  };

  balances: NormalizedBalance[] = [];

  rates: NormalizedRateSnapshot = {
    quality: 'complete',
    collectedAt: '2026-07-14T00:00:00.000Z',
    rates: [],
    sources: [{ source: 'fake', required: true, status: 'success' }],
  };

  manifest() {
    return {
      contractVersion: '1.0' as const,
      adapterType: 'fake-alerts',
      adapterVersion: '1.0.0',
      adapterSchemaVersion: 1,
      displayName: 'Fake alert adapter',
      monitorTypes: ['auth', 'balance', 'connectivity', 'rates'] as const,
      credentialFields: [{ key: 'access_token', input: 'password', secret: true, persistable: true }],
      sensitiveFields: [],
      capabilities: {
        authRefresh: false,
        balances: true,
        rates: true,
        channels: false,
        activeProbe: false,
      },
    };
  }

  async discover() {
    return {
      adapterType: 'fake-alerts',
      adapterVersion: '1.0.0',
      adapterSchemaVersion: 1,
      detectedAt: '2026-07-14T00:00:00.000Z',
      capabilities: {},
    };
  }

  async authenticate(_ctx: Parameters<RelayAdapter['authenticate']>[0], input: Parameters<RelayAdapter['authenticate']>[1]): Promise<AuthResult> {
    this.authInput = input;
    return {
      status: 'authenticated',
      tokens: { accessToken: 'unused', tokenType: 'Bearer' },
    };
  }

  async collectConnectivity(): Promise<HealthResult> {
    return this.health;
  }

  async collectBalances(): Promise<NormalizedBalance[]> {
    return this.balances;
  }

  async collectRates(): Promise<NormalizedRateSnapshot> {
    return this.rates;
  }
}

const contexts: AppContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

function setup() {
  const database = openDatabase({ path: ':memory:' });
  const vault = new CredentialVault(1, new Map([[1, randomBytes(32)]]));
  const adapter = new FakeAlertAdapter();
  const siteId = 'site_01KXG100000000000000000000';
  const channelId = 'channel_01KXG100000000000000000000';
  const context: AppContext = {
    config: {
      nodeEnv: 'test', host: '127.0.0.1', port: 8080, timezone: 'UTC', dataDir: '.',
      databasePath: ':memory:', masterKeyFile: 'unused', masterKeyVersion: 1, logLevel: 'silent',
      trustProxy: false, webOrigin: 'http://127.0.0.1:5173', databaseBusyTimeoutMs: 5_000,
      maxConcurrentSites: 5, outboundAllowedCidrs: [], isProduction: true,
    },
    database,
    vault,
    adapters: new AdapterRegistry([adapter]),
    startedAt: new Date().toISOString(),
    runtime: { schedulerRunning: false, schedulerLagMs: 0, lastScheduleSuccessAt: null },
    close: async () => { vault.destroy(); database.close(); },
  };
  contexts.push(context);
  database.db.insert(sites).values({
    id: siteId,
    adapterType: 'fake-alerts',
    name: 'Alert test site',
    baseUrl: 'https://1.1.1.1',
    tagsJson: '["production"]',
  }).run();
  database.db.insert(notificationChannels).values({
    id: channelId,
    name: 'Alert test channel',
    url: 'https://example.com/hook',
  }).run();
  return { context, adapter, siteId, channelId };
}

function seedRule(
  context: AppContext,
  channelId: string,
  type: string,
  condition: Record<string, unknown>,
  triggerConfirmCount = 2,
  recoveryConfirmCount = 1,
): void {
  const ruleId = `rule_${type}`;
  const revisionId = `revision_${type}`;
  context.database.db.insert(notificationRules).values({
    id: ruleId,
    name: `${type} test`,
    type,
    severity: type === 'site_down' ? 'critical' : 'warning',
    currentRevisionId: revisionId,
  }).run();
  context.database.db.insert(notificationRuleRevisions).values({
    id: revisionId,
    ruleId,
    revisionNumber: 1,
    scopeJson: '{"tags":["production"]}',
    conditionJson: JSON.stringify(condition),
    triggerConfirmCount,
    recoveryConfirmCount,
    sendRecovery: true,
    channelIdsJson: JSON.stringify([channelId]),
  }).run();
}

describe('monitor alert and outbox integration', () => {
  it('passes only adapter credentials to the independent auth monitor', async () => {
    const { context, adapter, siteId } = setup();
    context.database.db.update(sites).set({ accessExpiresAt: '2099-01-01T00:00:00.000Z' }).where(eq(sites.id, siteId)).run();
    storeCredentials(context.database, context.vault, siteId, {
      access_token: 'access-token',
      'rate_probe:rate_01:api_key': 'probe-secret',
    }, { persistKeys: ['access_token', 'rate_probe:rate_01:api_key'] });
    context.database.db.insert(monitorConfigs).values({
      id: 'monitor_auth_credential_filter',
      siteId,
      monitorType: 'auth',
      intervalSeconds: 60,
    }).run();

    const result = await runMonitor(context, siteId, 'auth', new AbortController().signal);

    expect(result).toEqual({ success: true });
    expect(adapter.authInput).toEqual({ mode: 'token', values: { access_token: 'access-token' } });
  });

  it('keeps transient retry attempts out of health history and the event center', async () => {
    const { context, adapter, siteId } = setup();
    context.database.db.insert(monitorConfigs).values({
      id: 'monitor_connectivity_retry_success',
      siteId,
      monitorType: 'connectivity',
      intervalSeconds: 60,
      retryCount: 1,
      retryIntervalSeconds: 0,
    }).run();
    adapter.health = {
      status: 'down', probeKind: 'model_api', authenticated: null, latencyMs: 15_000,
      checkedAt: '2026-07-14T00:01:00.000Z', errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Temporary network failure', retryable: true,
    };

    const retry = await runMonitor(
      context,
      siteId,
      'connectivity',
      new AbortController().signal,
      () => true,
      0,
    );
    expect(retry).toMatchObject({ success: false, retryable: true });
    expect(context.database.db.select().from(healthChecks).all()).toHaveLength(0);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(0);

    adapter.health = {
      status: 'healthy', probeKind: 'model_api', authenticated: null, latencyMs: 25,
      checkedAt: '2026-07-14T00:01:01.000Z',
    };
    const recovered = await runMonitor(
      context,
      siteId,
      'connectivity',
      new AbortController().signal,
      () => true,
      1,
    );
    expect(recovered).toEqual({ success: true });
    expect(context.database.db.select().from(healthChecks).all()).toHaveLength(1);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(0);
  });

  it('records and notifies only once after transient retries are exhausted', async () => {
    const { context, adapter, siteId, channelId } = setup();
    context.database.db.insert(monitorConfigs).values({
      id: 'monitor_connectivity_retry_exhausted',
      siteId,
      monitorType: 'connectivity',
      intervalSeconds: 60,
      retryCount: 1,
      retryIntervalSeconds: 0,
    }).run();
    seedRule(context, channelId, 'site_down', {}, 1, 1);
    adapter.health = {
      status: 'down', probeKind: 'model_api', authenticated: null, latencyMs: 15_000,
      checkedAt: '2026-07-14T00:02:00.000Z', errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Temporary network failure', retryable: true,
    };

    await runMonitor(
      context,
      siteId,
      'connectivity',
      new AbortController().signal,
      () => true,
      0,
    );
    expect(context.database.db.select().from(healthChecks).all()).toHaveLength(0);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(0);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(0);

    const final = await runMonitor(
      context,
      siteId,
      'connectivity',
      new AbortController().signal,
      () => true,
      1,
    );
    expect(final).toMatchObject({ success: false, retryable: false });
    expect(context.database.db.select().from(healthChecks).all()).toHaveLength(1);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(1);
    expect(context.database.db.select().from(incidents).all()[0]).toMatchObject({ state: 'firing' });
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
  });

  it('creates and recovers a site-down incident from collected health in the same commit', async () => {
    const { context, adapter, siteId, channelId } = setup();
    seedRule(context, channelId, 'site_down', {}, 2, 1);
    adapter.health = {
      status: 'down', probeKind: 'model_api', authenticated: null, latencyMs: 15_000,
      checkedAt: '2026-07-14T00:01:00.000Z', errorCode: 'UPSTREAM_UNREACHABLE',
      errorMessage: 'Authorization: Bearer super-secret-token',
    };

    await runMonitor(context, siteId, 'connectivity', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()[0]?.state).toBe('firing');
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
    adapter.health = { ...adapter.health, checkedAt: '2026-07-14T00:02:00.000Z' };
    await runMonitor(context, siteId, 'connectivity', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()[0]?.state).toBe('firing');
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
    expect(context.database.db.select().from(incidents).all()[0]?.detailsJson).not.toContain('super-secret-token');
    expect(context.database.db.select().from(outboxMessages).all()[0]?.payloadJson).not.toContain('super-secret-token');

    adapter.health = {
      status: 'healthy', probeKind: 'model_api', authenticated: null, latencyMs: 25,
      checkedAt: '2026-07-14T00:03:00.000Z',
    };
    await runMonitor(context, siteId, 'connectivity', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()[0]?.state).toBe('resolved');
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('uses exact balance thresholds and recovery hysteresis', async () => {
    const { context, adapter, siteId, channelId } = setup();
    seedRule(context, channelId, 'balance_low', {
      balance_key: 'cash', operator: 'lt', threshold: '10.00', recovery_threshold: '12.00',
    }, 1, 1);
    adapter.balances = [{
      balanceKey: 'cash', balanceKind: 'cash', value: '9.50', unit: 'USD',
      collectedAt: '2026-07-14T00:01:00.000Z',
    }];

    await runMonitor(context, siteId, 'balance', new AbortController().signal);
    expect(context.database.db.select().from(balanceSnapshots).all()[0]?.value).toBe('9.5');
    expect(context.database.db.select().from(incidents).all()[0]?.state).toBe('firing');
    adapter.balances = [{ ...adapter.balances[0]!, value: '11.00', collectedAt: '2026-07-14T00:02:00.000Z' }];
    await runMonitor(context, siteId, 'balance', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()[0]?.state).toBe('firing');
    adapter.balances = [{ ...adapter.balances[0]!, value: '12.00', collectedAt: '2026-07-14T00:03:00.000Z' }];
    await runMonitor(context, siteId, 'balance', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()[0]?.state).toBe('resolved');
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(2);
  });

  it('emits the first complete rate change immediately without duplicate notifications', async () => {
    const { context, adapter, siteId, channelId } = setup();
    seedRule(context, channelId, 'rate_changed', { directions: ['up'] }, 2, 1);
    const snapshot = (value: string, collectedAt: string): NormalizedRateSnapshot => ({
      quality: 'complete',
      collectedAt,
      sources: [{ source: 'fake', required: true, status: 'success' }],
      rates: [{
        rateKey: 'group:main', rateKind: 'group', name: 'Main group', value,
        unit: 'multiplier', comparisonKey: 'fake:group:main:v1', metadataStatus: 'available',
        probeStatus: 'not_configured', collectedAt, dataQuality: 'complete',
      }],
    });
    adapter.rates = snapshot('1.00', '2026-07-14T00:00:00.000Z');
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(0);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(0);
    adapter.rates = snapshot('2.00', '2026-07-14T00:01:00.000Z');
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toEqual([
      expect.objectContaining({
        eventType: 'rate.changed',
        state: 'resolved',
        triggerCount: 1,
        summary: 'Alert test site的分组“Main group”倍率由 1 变为 2。',
      }),
    ]);
    const payload = JSON.parse(context.database.db.select().from(outboxMessages).get()!.payloadJson) as {
      event: string;
      notification_kind: string;
      details: { rate_name: string; old_rate: string | null; new_rate: string | null; change_type: string };
    };
    expect(payload).toMatchObject({
      event: 'rate.changed',
      notification_kind: 'trigger',
      details: {
        rate_name: 'Main group',
        old_rate: '1',
        new_rate: '2',
        change_type: 'value_changed',
      },
    });
    const change = context.database.db.select().from(rateHistory)
      .where(eq(rateHistory.siteId, siteId)).get();
    expect(change?.changeType).toBe('value_changed');
    expect(change?.direction).toBe('up');
    expect(change?.oldValue).toBe('1');
    expect(change?.newValue).toBe('2');
    expect(change?.confirmedAt).toBe('2026-07-14T00:01:00.000Z');

    adapter.rates = snapshot('2.000', '2026-07-14T00:02:00.000Z');
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(1);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(1);
  });

  it('notifies additions, removals, and reappearances on their first complete snapshots', async () => {
    const { context, adapter, siteId, channelId } = setup();
    seedRule(context, channelId, 'monitor_events', {
      event_types: ['rate.added', 'rate.removed'],
    }, 1, 1);
    const snapshot = (
      collectedAt: string,
      items: ReadonlyArray<{ key: string; name: string; value: string }>,
    ): NormalizedRateSnapshot => ({
      quality: 'complete',
      collectedAt,
      sources: [{ source: 'fake', required: true, status: 'success' }],
      rates: items.map(({ key, name, value }) => ({
        rateKey: key,
        rateKind: 'group',
        name,
        value,
        unit: 'multiplier',
        comparisonKey: `fake:${key}:v1`,
        metadataStatus: 'available',
        probeStatus: 'not_configured',
        collectedAt,
        dataQuality: 'complete',
      })),
    });
    const main = { key: 'group:main', name: 'Main group', value: '1' };
    const grok = { key: 'group:grok', name: 'Grok', value: '0.05' };

    adapter.rates = snapshot('2026-07-14T00:00:00.000Z', [main]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);

    adapter.rates = snapshot('2026-07-14T00:01:00.000Z', [main, grok]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(1);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(1);
    expect(context.database.db.select().from(ratesCurrent)
      .where(eq(ratesCurrent.rateKey, grok.key)).get()).toMatchObject({
      metadataStatus: 'available',
      candidateValue: null,
      candidateCount: 0,
    });

    adapter.rates = snapshot('2026-07-14T00:02:00.000Z', [main, grok]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(1);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(1);

    adapter.rates = snapshot('2026-07-14T00:03:00.000Z', [main]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(2);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(2);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(2);
    expect(context.database.db.select().from(ratesCurrent)
      .where(eq(ratesCurrent.rateKey, grok.key)).get()).toMatchObject({
      missingCount: 1,
      metadataStatus: 'unavailable',
      removedAt: '2026-07-14T00:03:00.000Z',
    });

    adapter.rates = snapshot('2026-07-14T00:04:00.000Z', [main]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(2);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(2);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(2);

    adapter.rates = snapshot('2026-07-14T00:05:00.000Z', [main, grok]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(3);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(3);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(3);
    expect(context.database.db.select().from(ratesCurrent)
      .where(eq(ratesCurrent.rateKey, grok.key)).get()).toMatchObject({
      metadataStatus: 'available',
      removedAt: null,
      candidateCount: 0,
      missingCount: 0,
    });

    adapter.rates = snapshot('2026-07-14T00:06:00.000Z', [main, grok]);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    const payloads = context.database.db.select().from(outboxMessages)
      .orderBy(asc(outboxMessages.createdAt)).all()
      .map((row) => JSON.parse(row.payloadJson) as {
        event: string;
        incident: { summary: string };
        details: { rate_name: string; old_rate: string | null; new_rate: string | null };
      });
    expect(payloads).toEqual([
      expect.objectContaining({
        event: 'rate.added',
        incident: expect.objectContaining({
          summary: 'Alert test site新增分组“Grok”，倍率为 0.05。',
        }),
        details: expect.objectContaining({ rate_name: 'Grok', old_rate: null, new_rate: '0.05' }),
      }),
      expect.objectContaining({
        event: 'rate.removed',
        incident: expect.objectContaining({
          summary: 'Alert test site移除分组“Grok”，移除前倍率为 0.05。',
        }),
        details: expect.objectContaining({ rate_name: 'Grok', old_rate: '0.05', new_rate: null }),
      }),
      expect.objectContaining({
        event: 'rate.added',
        incident: expect.objectContaining({
          summary: 'Alert test site新增分组“Grok”，倍率为 0.05。',
        }),
        details: expect.objectContaining({ rate_name: 'Grok', old_rate: null, new_rate: '0.05' }),
      }),
    ]);
    const history = context.database.db.select().from(rateHistory)
      .orderBy(asc(rateHistory.confirmedAt)).all();
    expect(history.map((row) => row.changeType)).toEqual(['added', 'removed', 'added']);
    expect(history.map((row) => [row.oldValue, row.newValue])).toEqual([
      [null, '0.05'],
      ['0.05', null],
      [null, '0.05'],
    ]);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(3);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(3);
    expect(history).toHaveLength(3);
  });

  it('accepts a legacy stale addition on its first complete snapshot while a probe is active', async () => {
    const { context, adapter, siteId, channelId } = setup();
    seedRule(context, channelId, 'monitor_events', { event_types: ['rate.added'] }, 1, 1);
    const snapshot = (
      collectedAt: string,
      includeGrok: boolean,
    ): NormalizedRateSnapshot => ({
      quality: 'complete',
      collectedAt,
      sources: [{ source: 'fake', required: true, status: 'success' }],
      rates: [
        {
          rateKey: 'group:main', rateKind: 'group', name: 'Main group', value: '1',
          unit: 'multiplier', comparisonKey: 'fake:group:main:v1', metadataStatus: 'available',
          probeStatus: 'not_configured', collectedAt, dataQuality: 'complete',
        },
        ...(includeGrok ? [{
          rateKey: 'group:grok', rateKind: 'group' as const, name: 'Grok', value: '0.05',
          unit: 'multiplier', comparisonKey: 'fake:group:grok:v1', metadataStatus: 'available' as const,
          probeStatus: 'not_configured' as const, collectedAt, dataQuality: 'complete' as const,
        }] : []),
      ],
    });

    adapter.rates = snapshot('2026-07-14T00:00:00.000Z', false);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    const candidateId = 'rate_legacy_stale';
    context.database.db.insert(ratesCurrent).values({
      id: candidateId,
      siteId,
      rateKey: 'group:grok',
      rateKind: 'group',
      name: 'Grok',
      value: '0.05',
      unit: 'multiplier',
      comparisonKey: 'fake:group:grok:v1',
      metadataStatus: 'stale',
      probeStatus: 'not_configured',
      candidateValue: 'fake:group:grok:v1\u00000.05',
      candidateCount: 1,
      firstSeenAt: '2026-07-14T00:00:30.000Z',
      lastCheckedAt: '2026-07-14T00:00:30.000Z',
    }).run();
    const activeAt = new Date().toISOString();
    context.database.db.insert(rateProbeRuns).values({
      id: 'probe_running_candidate',
      rateId: candidateId,
      siteId,
      status: 'running',
      requestedModel: 'gpt-test',
      startedAt: activeAt,
      heartbeatAt: activeAt,
    }).run();

    adapter.rates = snapshot('2026-07-14T00:01:00.000Z', true);
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(ratesCurrent)
      .where(eq(ratesCurrent.id, candidateId)).get()).toMatchObject({
      metadataStatus: 'available',
      candidateValue: null,
      candidateCount: 0,
      missingCount: 0,
      removedAt: null,
    });
    expect(context.database.db.select().from(incidents).all()).toHaveLength(1);
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);
    expect(context.database.db.select().from(rateHistory).get()).toMatchObject({
      changeType: 'added',
      oldValue: null,
      newValue: '0.05',
      confirmedAt: '2026-07-14T00:01:00.000Z',
    });
  });

  it('evaluates legacy rate thresholds against the first accepted complete value', async () => {
    const { context, adapter, siteId, channelId } = setup();
    seedRule(context, channelId, 'rate_threshold', {
      operator: 'gt',
      threshold: '1.5',
      recovery_threshold: '1.5',
    }, 1, 1);
    const snapshot = (value: string, collectedAt: string): NormalizedRateSnapshot => ({
      quality: 'complete',
      collectedAt,
      sources: [{ source: 'fake', required: true, status: 'success' }],
      rates: [{
        rateKey: 'group:main', rateKind: 'group', name: 'Main group', value,
        unit: 'multiplier', comparisonKey: 'fake:group:main:v1', metadataStatus: 'available',
        probeStatus: 'not_configured', collectedAt, dataQuality: 'complete',
      }],
    });

    adapter.rates = snapshot('2', '2026-07-14T00:00:00.000Z');
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).get()).toMatchObject({
      eventType: 'rate.threshold',
      state: 'firing',
    });
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(1);

    adapter.rates = snapshot('1', '2026-07-14T00:01:00.000Z');
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).get()?.state).toBe('resolved');
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(2);
    expect(context.database.db.select().from(rateHistory).get()).toMatchObject({
      oldValue: '2',
      newValue: '1',
      confirmedAt: '2026-07-14T00:01:00.000Z',
    });

    adapter.rates = snapshot('1', '2026-07-14T00:02:00.000Z');
    await runMonitor(context, siteId, 'rates', new AbortController().signal);
    expect(context.database.db.select().from(incidents).get()?.state).toBe('resolved');
    expect(context.database.db.select().from(outboxMessages).all()).toHaveLength(2);
    expect(context.database.db.select().from(rateHistory).all()).toHaveLength(1);
  });
});
