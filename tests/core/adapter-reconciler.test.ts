import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ADAPTER_CONTRACT_VERSION,
  AdapterError,
  AdapterRegistry,
  type AdapterManifest,
  type AuthChallengeInput,
  type CredentialInput,
  type RelayAdapter,
  type SiteContext,
} from '../../backend/adapters/index.js';
import type { AppConfig } from '../../backend/config.js';
import type { AppContext } from '../../backend/context.js';
import { CredentialVault } from '../../backend/core/vault.js';
import {
  monitorConfigs,
  monitorJobs,
  openDatabase,
  siteCapabilities,
  sites,
} from '../../backend/db/index.js';
import {
  adapterCompatibility,
  compareAdapterVersions,
  reconcileAdapterStates,
  refreshSiteCapabilitiesIfDue,
} from '../../backend/services/adapter-reconciler.js';
import { createSchedulerRuntime } from '../../backend/services/scheduler-runtime.js';

const contexts: AppContext[] = [];

class FakeAdapter implements RelayAdapter {
  readonly credentialSchema = z.any() as z.ZodType<CredentialInput>;
  readonly #version: string;
  readonly #schemaVersion: number;
  failDiscovery = false;
  discoveryCalls = 0;

  constructor(version = '1.0.0', schemaVersion = 1) {
    this.#version = version;
    this.#schemaVersion = schemaVersion;
  }

  manifest(): AdapterManifest {
    return {
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapterType: 'fake',
      adapterVersion: this.#version,
      adapterSchemaVersion: this.#schemaVersion,
      displayName: 'Fake relay',
      monitorTypes: ['connectivity', 'rates', 'balance', 'auth'],
      credentialFields: [],
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

  async discover(ctx: SiteContext) {
    this.discoveryCalls += 1;
    if (this.failDiscovery) {
      throw new AdapterError('UPSTREAM_UNREACHABLE', 'Discovery failed', { retryable: true });
    }
    const checkedAt = (ctx.now ?? new Date()).toISOString();
    return {
      adapterType: 'fake',
      adapterVersion: this.#version,
      adapterSchemaVersion: this.#schemaVersion,
      detectedAt: checkedAt,
      capabilities: {
        rates: { status: 'supported' as const, checkedAt },
        balance: { status: 'supported' as const, checkedAt },
      },
    };
  }

  async authenticate(): Promise<never> {
    throw new Error('Not used by this test');
  }

  async completeAuthChallenge(_ctx: SiteContext, _input: AuthChallengeInput): Promise<never> {
    throw new Error('Not used by this test');
  }

  async collectConnectivity(): Promise<never> {
    throw new Error('Not used by this test');
  }

  async collectBalances(): Promise<never> {
    throw new Error('Not used by this test');
  }

  async collectRates(): Promise<never> {
    throw new Error('Not used by this test');
  }
}

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 8080,
    timezone: 'UTC',
    dataDir: '.',
    databasePath: ':memory:',
    masterKeyFile: 'unused-test-key',
    masterKeyVersion: 1,
    logLevel: 'silent',
    trustProxy: false,
    webOrigin: 'http://127.0.0.1:5173',
    databaseBusyTimeoutMs: 5_000,
    maxConcurrentSites: 5,
    outboundAllowedCidrs: ['127.0.0.0/8'],
    isProduction: false,
  };
}

function createContext(adapters: RelayAdapter[] = []): AppContext {
  const database = openDatabase({ path: ':memory:' });
  const vault = new CredentialVault(1, new Map([[1, Buffer.alloc(32, 7)]]));
  const context: AppContext = {
    config: testConfig(),
    database,
    vault,
    adapters: new AdapterRegistry(adapters),
    startedAt: '2026-07-14T00:00:00.000Z',
    runtime: { schedulerRunning: false, schedulerLagMs: 0, lastScheduleSuccessAt: null },
    close: async () => {
      vault.destroy();
      database.close();
    },
  };
  contexts.push(context);
  return context;
}

function insertSite(
  context: AppContext,
  options: {
    adapterVersion?: string;
    adapterSchemaVersion?: string;
    serviceStatus?: 'unknown' | 'adapter_unavailable';
    lastErrorCode?: string;
    includeDisabledMonitor?: boolean;
  } = {},
): void {
  context.database.db.insert(sites).values({
    id: 'site_test',
    adapterType: 'fake',
    adapterVersion: options.adapterVersion ?? '1.0.0',
    adapterSchemaVersion: options.adapterSchemaVersion ?? '1',
    name: 'Test relay',
    baseUrl: 'http://127.0.0.1:8080',
    serviceStatus: options.serviceStatus ?? 'unknown',
    lastErrorCode: options.lastErrorCode ?? null,
  }).run();
  const monitors = [
    { type: 'connectivity', enabled: true },
    ...(options.includeDisabledMonitor ? [{ type: 'balance', enabled: false }] : []),
  ] as const;
  for (const monitor of monitors) {
    context.database.db.insert(monitorConfigs).values({
      id: `config_${monitor.type}`,
      siteId: 'site_test',
      monitorType: monitor.type,
      enabled: monitor.enabled,
      intervalSeconds: 60,
      timeoutSeconds: 15,
      scheduleJitterPercent: 0,
    }).run();
    context.database.db.insert(monitorJobs).values({
      id: `job_${monitor.type}`,
      siteId: 'site_test',
      monitorType: monitor.type,
      state: monitor.enabled ? 'queued' : 'disabled',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    }).run();
  }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

describe('adapter reconciliation', () => {
  it('disables an unknown adapter at scheduler startup and restores only enabled monitors when installed', async () => {
    const context = createContext();
    insertSite(context, { includeDisabledMonitor: true });
    const runtime = createSchedulerRuntime(context, vi.fn());
    await runtime.start();
    await runtime.stop();

    expect(context.database.db.select().from(sites).get()).toMatchObject({
      serviceStatus: 'adapter_unavailable',
      lastErrorCode: 'ADAPTER_UNAVAILABLE',
    });
    expect(context.database.db.select().from(monitorJobs).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'job_connectivity', state: 'disabled', lastErrorCode: 'ADAPTER_UNAVAILABLE' }),
      expect.objectContaining({ id: 'job_balance', state: 'disabled', lastErrorCode: 'ADAPTER_UNAVAILABLE' }),
    ]));

    context.adapters.register(new FakeAdapter('1.2.0'));
    const recoveredAt = new Date('2026-07-14T01:00:00.000Z');
    const summary = reconcileAdapterStates(context, recoveredAt);
    expect(summary).toMatchObject({ unavailable: 0, restoredJobs: 1 });
    expect(context.database.db.select().from(sites).get()).toMatchObject({
      adapterVersion: '1.2.0',
      serviceStatus: 'unknown',
      lastErrorCode: null,
    });
    expect(context.database.db.select().from(monitorJobs).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'job_connectivity', state: 'queued', nextRunAt: recoveredAt.toISOString() }),
      expect.objectContaining({ id: 'job_balance', state: 'disabled', lastErrorCode: null }),
    ]));
  });

  it('rejects an installed adapter older than the saved version or schema requirement', () => {
    const adapter = new FakeAdapter('1.4.0', 2);
    const context = createContext([adapter]);
    insertSite(context, { adapterVersion: '2.0.0', adapterSchemaVersion: '2' });

    const summary = reconcileAdapterStates(context, new Date('2026-07-14T00:00:00.000Z'));
    expect(summary.unavailable).toBe(1);
    expect(context.database.db.select().from(sites).get()).toMatchObject({
      serviceStatus: 'adapter_unavailable',
      lastErrorCode: 'ADAPTER_UNAVAILABLE',
    });
    expect(context.database.db.select().from(monitorJobs).get()).toMatchObject({ state: 'disabled' });
    expect(adapterCompatibility(adapter.manifest(), '1.4.0', '2').compatible).toBe(true);
    expect(adapterCompatibility(adapter.manifest(), '1.4.0', '3')).toMatchObject({
      compatible: false,
      reason: 'schema_too_old',
    });
    expect(compareAdapterVersions('1.4.0', '1.4.0-beta.1')).toBe(1);
  });

  it('probes capabilities immediately, persists them, and waits for the daily interval', async () => {
    const adapter = new FakeAdapter();
    const context = createContext([adapter]);
    insertSite(context);
    const firstAt = new Date('2026-07-14T00:00:00.000Z');
    const reconciliation = reconcileAdapterStates(context, firstAt);
    expect(reconciliation.scheduledProbes).toBe(1);
    expect(context.database.db.select().from(monitorJobs).get()?.nextRunAt).toBe(firstAt.toISOString());

    await expect(refreshSiteCapabilitiesIfDue(context, 'site_test', { now: firstAt }))
      .resolves.toMatchObject({ attempted: true, persisted: true });
    expect(adapter.discoveryCalls).toBe(1);
    expect(context.database.db.select().from(siteCapabilities).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityKey: 'rates', status: 'supported', detectedAt: firstAt.toISOString() }),
      expect.objectContaining({ capabilityKey: 'balance', status: 'supported', detectedAt: firstAt.toISOString() }),
    ]));

    await expect(refreshSiteCapabilitiesIfDue(context, 'site_test', {
      now: new Date(firstAt.getTime() + 23 * 60 * 60_000),
    })).resolves.toEqual({ attempted: false, persisted: false });
    expect(adapter.discoveryCalls).toBe(1);

    await expect(refreshSiteCapabilitiesIfDue(context, 'site_test', {
      now: new Date(firstAt.getTime() + 25 * 60 * 60_000),
    })).resolves.toMatchObject({ attempted: true, persisted: true });
    expect(adapter.discoveryCalls).toBe(2);

    context.database.db.update(siteCapabilities).set({ adapterVersion: '0.9.0' }).run();
    await expect(refreshSiteCapabilitiesIfDue(context, 'site_test', {
      now: new Date(firstAt.getTime() + 25 * 60 * 60_000 + 60_000),
    })).resolves.toMatchObject({ attempted: true, persisted: true });
    expect(adapter.discoveryCalls).toBe(3);
  });

  it('persists a sanitized failed probe marker so transient failures are also throttled', async () => {
    const adapter = new FakeAdapter();
    adapter.failDiscovery = true;
    const context = createContext([adapter]);
    insertSite(context);
    const firstAt = new Date('2026-07-14T00:00:00.000Z');

    await expect(refreshSiteCapabilitiesIfDue(context, 'site_test', { now: firstAt }))
      .resolves.toMatchObject({ attempted: true, persisted: true, errorCode: 'UPSTREAM_UNREACHABLE' });
    expect(context.database.db.select().from(siteCapabilities).get()).toMatchObject({
      capabilityKey: 'adapter.discovery',
      status: 'unknown',
      lastErrorCode: 'UPSTREAM_UNREACHABLE',
    });
    await refreshSiteCapabilitiesIfDue(context, 'site_test', {
      now: new Date(firstAt.getTime() + 60_000),
    });
    expect(adapter.discoveryCalls).toBe(1);
  });
});
