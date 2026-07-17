import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AdapterError } from '../../backend/adapters/index.js';
import type {
  AuthResult,
  CreateProbeApiKeyRequest,
  HealthResult,
  ModelProbeRequest,
  NormalizedRateSnapshot,
  RelayAdapter,
  SiteContext,
} from '../../backend/adapters/index.js';
import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import { createAppContext, type AppContext } from '../../backend/context.js';
import { hashAdminPassword } from '../../backend/core/password.js';
import {
  admins,
  credentials,
  incidents,
  monitorConfigs,
  monitorJobs,
  notificationRuleRevisions,
  notificationRules,
  rateHistory,
  rateProbeConfigs,
  rateProbeRuns,
  ratesCurrent,
  siteProbeKeyMappings,
  sites,
} from '../../backend/db/index.js';
import { storeCredentials } from '../../backend/services/credentials.js';
import { createRateProbeScheduler } from '../../backend/services/rate-probe-scheduler.js';

class FakeProbeAdapter implements RelayAdapter {
  readonly credentialSchema = z.object({
    mode: z.enum(['password', 'token']),
    values: z.record(z.string(), z.union([z.string(), z.boolean(), z.undefined()])),
  });
  probeCalls = 0;
  lastApiKey: string | undefined;
  lastTimeoutMs: number | undefined;
  probeTimeouts: number[] = [];
  lastCanary = '';
  createdKeys = 0;
  deletedKeyIds: string[] = [];
  lastCreateIdempotencyKey: string | undefined;
  lastCreateInput: CreateProbeApiKeyRequest | undefined;
  probeFailure: AdapterError | null = null;
  probeFailures: Array<AdapterError | null> = [];
  authFailure: AdapterError | null = null;

  manifest() {
    return {
      contractVersion: '1.0' as const,
      adapterType: 'fake-probe', adapterVersion: '1.0.0', adapterSchemaVersion: 1,
      displayName: 'Fake probe', monitorTypes: ['connectivity', 'rates', 'balance', 'auth'] as const,
      credentialFields: [], sensitiveFields: [],
      capabilities: { authRefresh: false, balances: false, rates: true, channels: false, activeProbe: true },
    };
  }
  async discover() {
    return { adapterType: 'fake-probe', adapterVersion: '1.0.0', adapterSchemaVersion: 1, detectedAt: new Date().toISOString(), capabilities: {} };
  }
  async authenticate(): Promise<AuthResult> {
    if (this.authFailure) throw this.authFailure;
    return { status: 'authenticated', tokens: { accessToken: 'unused', tokenType: 'Bearer' } };
  }
  async collectConnectivity(): Promise<HealthResult> {
    return { status: 'healthy', probeKind: 'model_api', authenticated: true, latencyMs: 1, checkedAt: new Date().toISOString() };
  }
  async collectBalances() { return []; }
  async collectRates(): Promise<NormalizedRateSnapshot> {
    return { quality: 'complete', collectedAt: new Date().toISOString(), rates: [], sources: [] };
  }
  async listProbeModels(ctx: SiteContext) {
    this.lastApiKey = ctx.credentials?.api_key;
    this.lastTimeoutMs = ctx.timeoutMs;
    return { models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-test' }], fetchedAt: new Date().toISOString() };
  }
  async listProbeApiKeys() {
    return [{
      id: '90', name: 'Existing group key', groupId: '12', groupName: 'Probe Group',
      status: 'active', expiresAt: null, quota: '2', quotaUsed: '0.25', secretKey: 'sk-upstream-secret',
    }];
  }
  async createProbeApiKey(_ctx: SiteContext, input: CreateProbeApiKeyRequest) {
    this.createdKeys += 1;
    this.lastCreateIdempotencyKey = input.idempotencyKey;
    this.lastCreateInput = { ...input };
    return {
      id: `created-${this.createdKeys}`, name: input.name, groupId: input.groupId, groupName: 'Probe Group',
      status: 'active', expiresAt: null, quota: input.quota === undefined ? null : String(input.quota),
      quotaUsed: '0', secretKey: 'sk-created-secret',
    };
  }
  async deleteProbeApiKey(_ctx: SiteContext, upstreamKeyId: string) {
    this.deletedKeyIds.push(upstreamKeyId);
  }
  async probeModel(ctx: SiteContext, input: ModelProbeRequest) {
    this.probeCalls += 1;
    this.lastApiKey = ctx.credentials?.api_key;
    this.lastTimeoutMs = ctx.timeoutMs;
    this.probeTimeouts.push(ctx.timeoutMs);
    const queuedFailure = this.probeFailures.length > 0 ? this.probeFailures.shift() : this.probeFailure;
    if (queuedFailure) throw queuedFailure;
    this.lastCanary = /RELAY_MONITOR_[A-F0-9]+/.exec(input.userPrompt)?.[0] ?? '';
    return {
      requestedModel: input.model, returnedModel: 'gpt-5.6-2026-07-01', httpStatus: 200,
      ttfbMs: 120, ttftMs: 300, totalMs: 2_989, generationMs: 2_689,
      usage: { promptTokens: 200, completionTokens: 86, totalTokens: 286, cachedInputTokens: 40, reasoningTokens: 12 },
      tps: '31.99', finishReason: 'stop', systemFingerprint: 'deprecated-weak-fingerprint',
      toolCallsObserved: false, upstreamToolsObserved: false, outputText: `Landry\n${this.lastCanary}`,
    };
  }
}

interface Fixture { app: FastifyInstance; context: AppContext; adapter: FakeProbeAdapter; directory: string; cookie: string; csrf: string }
const fixtures: Fixture[] = [];

function cookiesFrom(value: string | string[] | undefined): string {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => item.split(';', 1)[0]).join('; ');
}

async function fixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-probes-'));
  const context = createAppContext(loadConfig({
    ...process.env, NODE_ENV: 'test', DATA_DIR: directory,
    DATABASE_URL: join(directory, 'monitor.db'), MASTER_KEY_FILE: join(directory, 'master.key'), LOG_LEVEL: 'silent',
  }));
  const adapter = new FakeProbeAdapter();
  context.adapters.register(adapter);
  context.database.db.insert(admins).values({
    id: 'admin_probe', username: 'admin', displayName: 'Probe Admin',
    passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
  }).run();
  context.database.db.insert(sites).values({
    id: 'site_probe', adapterType: 'fake-probe', name: 'Probe Site', baseUrl: 'https://1.1.1.1',
  }).run();
  const now = new Date().toISOString();
  context.database.db.insert(ratesCurrent).values({
    id: 'rate_probe', siteId: 'site_probe', rateKey: 'group:1:effective', rateKind: 'group',
    name: 'Probe Group', value: '0.1', unit: 'multiplier', comparisonKey: 'fake:group:v1',
    attributesJson: JSON.stringify({ group_id: '12' }), firstSeenAt: now, lastCheckedAt: now,
  }).run();
  context.database.db.insert(monitorConfigs).values({
    id: 'monitor_config_probe', siteId: 'site_probe', monitorType: 'connectivity',
    intervalSeconds: 300, timeoutSeconds: 15,
  }).run();
  context.database.db.insert(monitorJobs).values({
    id: 'monitor_job_probe', siteId: 'site_probe', monitorType: 'connectivity',
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  }).run();
  storeCredentials(context.database, context.vault, 'site_probe', { api_key: 'site-key' }, { persistKeys: ['api_key'] });
  const app = await buildApp({ context, closeContext: false, startScheduler: false, startOutboxWorker: false });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/session/login', payload: { username: 'admin', password: 'correct-horse-battery-staple' } });
  const result = { app, context, adapter, directory, cookie: cookiesFrom(login.headers['set-cookie']), csrf: login.json().data.csrf_token };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.app.close();
    await item.context.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe('rate model probe API', () => {
  it('paginates probe history in the database while preserving newest-first order and total', async () => {
    const test = await fixture();
    test.context.database.db.insert(rateProbeRuns).values(
      Array.from({ length: 5 }, (_, index) => ({
        id: `proberun_page_${index + 1}`,
        rateId: 'rate_probe',
        siteId: 'site_probe',
        status: 'failed' as const,
        requestedModel: 'gpt-test',
        startedAt: `2026-07-17T00:0${index === 1 ? 3 : index + 1}:00.000Z`,
      })),
    ).run();

    const response = await test.app.inject({
      method: 'GET',
      url: '/api/v1/rates/rate_probe/probes?page=2&page_size=2',
      headers: { cookie: test.cookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      page: 2,
      page_size: 2,
      total: 5,
    });
    expect(response.json().data.items.map((item: { id: string }) => item.id)).toEqual([
      'proberun_page_3',
      'proberun_page_2',
    ]);
  });

  it('returns the new probe retry defaults before a configuration is saved', async () => {
    const test = await fixture();
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers: { cookie: test.cookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      configured: false,
      probe_interval_seconds: 3_600,
      timeout_seconds: 30,
      retry_count: 3,
      retry_interval_seconds: 60,
      auto_create_quota_limit: null,
      auto_create_expires_in_seconds: null,
    });

    const saved = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers: { cookie: test.cookie, 'x-csrf-token': test.csrf },
      payload: {
        model_mode: 'manual',
        model: 'gpt-test',
        use_site_api_key: true,
        max_output_tokens: 96,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({
      configured: true,
      timeout_seconds: 30,
      retry_count: 3,
      retry_interval_seconds: 60,
    });
    expect(test.context.database.db.select().from(rateProbeConfigs).get()).toMatchObject({
      timeoutSeconds: 30,
      retryCount: 3,
      retryIntervalSeconds: 60,
    });
  });

  it('accepts any positive whole-minute automatic probe interval', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    const payload = {
      model_mode: 'manual',
      model: 'gpt-test',
      use_site_api_key: true,
      max_output_tokens: 96,
      auto_probe_enabled: true,
    };

    const oneMinute = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers,
      payload: { ...payload, probe_interval_seconds: 60 },
    });
    expect(oneMinute.statusCode, oneMinute.body).toBe(200);
    expect(oneMinute.json().data.probe_interval_seconds).toBe(60);

    const sevenDays = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers,
      payload: { ...payload, probe_interval_seconds: 7 * 86_400 },
    });
    expect(sevenDays.statusCode, sevenDays.body).toBe(200);
    expect(sevenDays.json().data.probe_interval_seconds).toBe(7 * 86_400);

    const partialMinute = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers,
      payload: { ...payload, probe_interval_seconds: 61 },
    });
    expect(partialMinute.statusCode).toBe(400);
  });

  it('applies the ordinary monitor defaults when site creation omits them', async () => {
    const test = await fixture();
    const headers = {
      cookie: test.cookie,
      'x-csrf-token': test.csrf,
      'idempotency-key': 'site-default-monitor-retry',
    };
    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers,
      payload: {
        name: 'Created Default Retry Site',
        adapter_type: 'fake-probe',
        base_url: 'https://1.1.1.2',
        tags: [],
        tls_verify: true,
        rate_group_scope: { mode: 'all', group_ids: [] },
        probe_key_mappings: [],
      },
    });

    expect(created.statusCode, created.body).toBe(201);
    const responseData = created.json().data as {
      id: string;
      monitor_configs: Array<{
        interval_seconds: number;
        timeout_seconds: number;
        retry_count: number;
        retry_interval_seconds: number;
      }>;
    };
    expect(responseData.monitor_configs).toHaveLength(4);
    expect(responseData.monitor_configs.every((monitor) => (
      monitor.interval_seconds === 300
      && monitor.timeout_seconds === 15
      && monitor.retry_count === 1
      && monitor.retry_interval_seconds === 60
    ))).toBe(true);

    const persisted = test.context.database.db.select().from(monitorConfigs)
      .where(eq(monitorConfigs.siteId, responseData.id)).all();
    expect(persisted).toHaveLength(4);
    expect(persisted.every((monitor) => (
      monitor.intervalSeconds === 300
      && monitor.timeoutSeconds === 15
      && monitor.retryCount === 1
      && monitor.retryIntervalSeconds === 60
    ))).toBe(true);
  });

  it('creates a site with an unlimited non-expiring probe key mapping', async () => {
    const test = await fixture();
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: {
        cookie: test.cookie,
        'x-csrf-token': test.csrf,
        'idempotency-key': 'site-create-unlimited-key',
      },
      payload: {
        name: 'Unlimited Key Site',
        adapter_type: 'fake-probe',
        base_url: 'https://1.1.1.4',
        credentials: {
          mode: 'token',
          values: { access_token: 'site-access-token' },
          persist_keys: ['access_token'],
        },
        rate_group_scope: { mode: 'selected', group_ids: ['12'] },
        probe_key_mappings: [{ group_id: '12', mode: 'auto_create' }],
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(test.adapter.lastCreateInput).not.toHaveProperty('quota');
    expect(test.adapter.lastCreateInput).not.toHaveProperty('expiresInDays');
    expect(test.context.database.db.select().from(siteProbeKeyMappings).get()).toMatchObject({
      groupId: '12',
      quotaLimit: null,
      expiresInSeconds: null,
    });
  });

  it('returns a Chinese authentication error without persisting rejected credentials', async () => {
    const test = await fixture();
    test.adapter.authFailure = new AdapterError(
      'AUTH_INVALID_CREDENTIALS',
      'Invalid credentials',
      { httpStatus: 401 },
    );
    const created = await test.app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: {
        cookie: test.cookie,
        'x-csrf-token': test.csrf,
        'idempotency-key': 'site-invalid-upstream-credentials',
      },
      payload: {
        name: 'Rejected Credentials Site',
        adapter_type: 'fake-probe',
        base_url: 'https://1.1.1.3',
        credentials: {
          mode: 'password',
          values: { email: 'user@example.test', password: 'not-a-real-secret' },
        },
        rate_group_scope: { mode: 'all', group_ids: [] },
        probe_key_mappings: [],
      },
    });

    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '邮箱或密码错误，或目标站点拒绝了登录凭据（HTTP 401）。',
    });
    expect(created.body).not.toContain('Invalid credentials');
    expect(test.context.database.db.select().from(sites)
      .where(eq(sites.name, 'Rejected Credentials Site')).get()).toBeUndefined();
  });

  it('returns the latest rate monitor result with every rate row', async () => {
    const test = await fixture();
    test.context.database.db.insert(monitorJobs).values({
      id: 'monitor_job_rates', siteId: 'site_probe', monitorType: 'rates', state: 'retry',
      nextRunAt: '2026-07-15T01:02:00.000Z', lastFinishedAt: '2026-07-15T01:00:00.000Z',
      lastSuccessAt: '2026-07-15T00:55:00.000Z', lastErrorCode: 'UPSTREAM_UNREACHABLE',
      lastErrorMessage: 'Network request failed',
    }).run();

    const response = await test.app.inject({
      method: 'GET', url: '/api/v1/rates?page=1&page_size=20', headers: { cookie: test.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items[0]).toMatchObject({
      id: 'rate_probe',
      rate_monitor: {
        state: 'retry',
        last_finished_at: '2026-07-15T01:00:00.000Z',
        last_success_at: '2026-07-15T00:55:00.000Z',
        last_error_code: 'UPSTREAM_UNREACHABLE',
        last_error_message: 'Network request failed',
      },
    });
  });

  it('keeps Responses request evidence and a Chinese explanation when the upstream fails', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    const saved = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers,
      payload: {
        model_mode: 'manual',
        model: 'gpt-5.6-sol',
        use_site_api_key: false,
        custom_api_key: 'sk-failure-test',
        max_output_tokens: 96,
        retry_count: 0,
        retry_interval_seconds: 0,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    test.adapter.probeFailure = new AdapterError(
      'UPSTREAM_SERVER_ERROR',
      'The upstream model endpoint returned an error',
      { httpStatus: 502, retryable: true },
    );
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rates/rate_probe/probe',
      headers: { ...headers, 'idempotency-key': 'failed-responses-probe' },
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'failed',
      http_status: 502,
      error_code: 'UPSTREAM_SERVER_ERROR',
      evidence: {
        request_protocol: 'responses',
        request_path: '/v1/responses',
        client_tools_declared: false,
        client_tool_choice: 'none',
        request_failed: true,
      },
    });
    expect(response.json().data.error_message).toContain('上游模型接口返回服务器错误（HTTP 502）');
    expect(response.json().data.total_ms).toBeGreaterThanOrEqual(0);
    expect(response.body).not.toContain('The upstream model endpoint returned an error');
  });

  it('retries a transient failure and records one successful logical probe', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    const saved = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers,
      payload: {
        model_mode: 'manual',
        model: 'gpt-test',
        use_site_api_key: true,
        max_output_tokens: 96,
        timeout_seconds: 19,
        retry_count: 1,
        retry_interval_seconds: 0,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ retry_count: 1, retry_interval_seconds: 0 });

    test.adapter.probeFailures = [
      new AdapterError('UPSTREAM_SERVER_ERROR', 'temporary upstream failure', {
        httpStatus: 502,
        retryable: true,
      }),
      null,
    ];
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rates/rate_probe/probe',
      headers: { ...headers, 'idempotency-key': 'probe-transient-retry' },
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'success',
      attempt_count: 2,
      evidence: {
        attempt_count: 2,
        max_attempts: 2,
        timeout_seconds: 19,
        retry_interval_seconds: 0,
      },
    });
    expect(test.adapter.probeCalls).toBe(2);
    expect(test.adapter.probeTimeouts).toEqual([19_000, 19_000]);
    expect(test.context.database.db.select().from(incidents)
      .where(eq(incidents.eventType, 'probe.failed')).all()).toHaveLength(0);
  });

  it('emits one terminal failure after retry exhaustion and records every attempt', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    const saved = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers,
      payload: {
        model_mode: 'manual',
        model: 'gpt-test',
        use_site_api_key: true,
        max_output_tokens: 96,
        retry_count: 2,
        retry_interval_seconds: 0,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const failure = () => new AdapterError('UPSTREAM_SERVER_ERROR', 'temporary upstream failure', {
      httpStatus: 502,
      retryable: true,
    });
    test.adapter.probeFailures = [failure(), failure(), failure()];
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/rates/rate_probe/probe',
      headers: { ...headers, 'idempotency-key': 'probe-retry-exhausted' },
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'failed',
      attempt_count: 3,
      error_code: 'UPSTREAM_SERVER_ERROR',
      evidence: {
        attempt_count: 3,
        max_attempts: 3,
        request_failed: true,
      },
    });
    expect(test.adapter.probeCalls).toBe(3);
    expect(test.context.database.db.select().from(incidents)
      .where(eq(incidents.eventType, 'probe.failed')).all()).toHaveLength(1);
  });

  it('rejects Responses output budgets below the upstream minimum', async () => {
    const test = await fixture();
    const response = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers: { cookie: test.cookie, 'x-csrf-token': test.csrf },
      payload: { model_mode: 'manual', model: 'gpt-test', max_output_tokens: 15 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects model probe request timeouts outside the supported range', async () => {
    const test = await fixture();
    const response = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers: { cookie: test.cookie, 'x-csrf-token': test.csrf },
      payload: {
        model_mode: 'manual',
        model: 'gpt-test',
        max_output_tokens: 96,
        timeout_seconds: 301,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates an upstream key idempotently and revokes managed keys before deletion', async () => {
    const test = await fixture();
    const headers = {
      cookie: test.cookie,
      'x-csrf-token': test.csrf,
      'idempotency-key': 'rate-probe-auto-key-1',
    };
    const payload = {
      model_mode: 'manual',
      model: 'gpt-test',
      key_mode: 'auto_create',
      max_output_tokens: 64,
      auto_probe_enabled: false,
      probe_interval_seconds: 3_600,
      auto_create: { quota_limit: 0.5, expires_in_seconds: 86_400 },
    };
    const created = await test.app.inject({
      method: 'PUT', url: '/api/v1/rates/rate_probe/probe-config', headers, payload,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data).toMatchObject({
      key_mode: 'bound', upstream_key_id: 'created-1', bound_key_present: true,
    });
    expect(test.adapter.createdKeys).toBe(1);
    expect(test.adapter.lastCreateIdempotencyKey).toMatch(/^relay-monitor-[a-f0-9]{64}$/);
    expect(test.adapter.lastCreateInput).toMatchObject({ quota: 0.5, expiresInDays: 1 });
    expect(created.body).not.toContain('sk-created-secret');

    const replay = await test.app.inject({
      method: 'PUT', url: '/api/v1/rates/rate_probe/probe-config', headers, payload,
    });
    expect(replay.json()).toEqual(created.json());
    expect(test.adapter.createdKeys).toBe(1);

    const deleted = await test.app.inject({
      method: 'DELETE',
      url: '/api/v1/rates/rate_probe',
      headers: { cookie: test.cookie, 'x-csrf-token': test.csrf },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(test.adapter.deletedKeyIds).toEqual(['created-1']);
  });

  it('omits quota and expiry when automatically creating an unlimited non-expiring key', async () => {
    const test = await fixture();
    const response = await test.app.inject({
      method: 'PUT',
      url: '/api/v1/rates/rate_probe/probe-config',
      headers: {
        cookie: test.cookie,
        'x-csrf-token': test.csrf,
        'idempotency-key': 'rate-probe-unlimited-key',
      },
      payload: {
        model_mode: 'manual',
        model: 'gpt-test',
        key_mode: 'auto_create',
        max_output_tokens: 96,
        auto_create: {},
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      key_mode: 'bound',
      auto_create_quota_limit: null,
      auto_create_expires_in_seconds: null,
    });
    expect(test.adapter.lastCreateInput).not.toHaveProperty('quota');
    expect(test.adapter.lastCreateInput).not.toHaveProperty('expiresInDays');
    expect(test.context.database.db.select().from(rateProbeConfigs).get()).toMatchObject({
      autoCreateQuotaLimit: null,
      autoCreateExpiresInSeconds: null,
    });
  });

  it('allows the direct site key endpoint to omit quota and expiry', async () => {
    const test = await fixture();
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/v1/sites/site_probe/upstream-api-keys',
      headers: {
        cookie: test.cookie,
        'x-csrf-token': test.csrf,
        'idempotency-key': 'site-unlimited-key',
      },
      payload: { group_id: '12' },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(test.adapter.lastCreateInput).not.toHaveProperty('quota');
    expect(test.adapter.lastCreateInput).not.toHaveProperty('expiresInDays');
  });

  it('updates site scope and monitor timing while preserving omitted credentials', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    storeCredentials(test.context.database, test.context.vault, 'site_probe', {
      'rate_probe:rate_probe:api_key': 'internal-probe-key',
    }, { persistKeys: ['rate_probe:rate_probe:api_key'] });

    const updated = await test.app.inject({
      method: 'PATCH', url: '/api/v1/sites/site_probe', headers,
      payload: {
        name: 'Updated Probe Site',
        rate_group_scope: { mode: 'selected', group_ids: ['12'] },
        monitors: {
          connectivity: {
            interval_seconds: 1_234,
            timeout_seconds: 42,
            retry_count: 3,
            retry_interval_seconds: 17,
          },
        },
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data).toMatchObject({
      name: 'Updated Probe Site',
      tls_verify: true,
      rate_group_scope: { mode: 'selected', group_ids: ['12'] },
      credential_status: { present_keys: ['api_key'] },
    });
    expect(test.context.database.db.select().from(monitorConfigs).get()).toMatchObject({
      intervalSeconds: 1_234,
      timeoutSeconds: 42,
      retryCount: 3,
      retryIntervalSeconds: 17,
    });
    expect(updated.json().data.monitor_configs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        monitor_type: 'connectivity',
        interval_seconds: 1_234,
        timeout_seconds: 42,
        retry_count: 3,
        retry_interval_seconds: 17,
      }),
    ]));
    expect(test.context.database.db.select().from(monitorJobs).get()).toMatchObject({ state: 'queued' });
    expect(test.context.database.db.select().from(credentials)
      .where(eq(credentials.credentialType, 'api_key')).get()?.revokedAt).toBeNull();
    expect(test.context.database.db.select().from(credentials)
      .where(eq(credentials.credentialType, 'rate_probe:rate_probe:api_key')).get()?.revokedAt).toBeNull();

    const unsafeOriginChange = await test.app.inject({
      method: 'PATCH', url: '/api/v1/sites/site_probe', headers,
      payload: { base_url: 'https://2.2.2.2' },
    });
    expect(unsafeOriginChange.statusCode).toBe(400);
    expect(unsafeOriginChange.json().error.code).toBe('CREDENTIALS_REQUIRED_FOR_ORIGIN_CHANGE');
  });

  it('updates an independent monitor retry policy and clears a pending retry job', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    const existingJob = test.context.database.db.select().from(monitorJobs)
      .where(eq(monitorJobs.siteId, 'site_probe')).get();
    expect(existingJob).toBeDefined();
    test.context.database.db.update(monitorJobs).set({
      state: 'retry',
      attempts: 2,
      retryAfter: '2099-01-01T00:00:30.000Z',
      lastErrorCode: 'UPSTREAM_SERVER_ERROR',
      lastErrorMessage: 'temporary failure',
      leaseOwner: null,
      leaseUntil: null,
    }).where(eq(monitorJobs.id, existingJob!.id)).run();

    const updated = await test.app.inject({
      method: 'PATCH',
      url: '/api/v1/sites/site_probe/monitors/connectivity',
      headers,
      payload: {
        enabled: true,
        interval_seconds: 180,
        timeout_seconds: 20,
        retry_count: 4,
        retry_interval_seconds: 33,
        schedule_jitter_percent: 0,
      },
    });

    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data).toMatchObject({
      monitor_type: 'connectivity',
      retry_count: 4,
      retry_interval_seconds: 33,
    });
    expect(test.context.database.db.select().from(monitorConfigs)
      .where(eq(monitorConfigs.siteId, 'site_probe')).get()).toMatchObject({
      intervalSeconds: 180,
      timeoutSeconds: 20,
      retryCount: 4,
      retryIntervalSeconds: 33,
    });
    expect(test.context.database.db.select().from(monitorJobs)
      .where(eq(monitorJobs.id, existingJob!.id)).get()).toMatchObject({
      state: 'queued',
      attempts: 0,
      retryAfter: null,
      leaseOwner: null,
      leaseUntil: null,
      runRequested: false,
    });
  });

  it('masks upstream keys, binds an existing group key, schedules probes, and excludes deleted rates', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };

    const keys = await test.app.inject({
      method: 'GET', url: '/api/v1/sites/site_probe/upstream-api-keys', headers: { cookie: test.cookie },
    });
    expect(keys.statusCode, keys.body).toBe(200);
    expect(keys.json().data.items).toEqual([expect.objectContaining({
      id: '90', group_id: '12', name: 'Existing group key',
    })]);
    expect(keys.body).not.toContain('sk-upstream-secret');

    const saved = await test.app.inject({
      method: 'PUT', url: '/api/v1/rates/rate_probe/probe-config', headers,
      payload: {
        model_mode: 'manual', model: 'gpt-5.6-sol', key_mode: 'existing', upstream_key_id: '90',
        max_output_tokens: 96, auto_probe_enabled: true, probe_interval_seconds: 900,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({
      key_mode: 'bound', bound_key_present: true, upstream_key_id: '90',
      auto_probe_enabled: true, probe_interval_seconds: 900,
    });
    expect(saved.body).not.toContain('sk-upstream-secret');

    test.context.database.db.update(rateProbeConfigs).set({ nextRunAt: '2000-01-01T00:00:00.000Z' }).run();
    const errors: unknown[] = [];
    const scheduler = createRateProbeScheduler(test.context, (error) => errors.push(error));
    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    await scheduler.stop();
    expect(errors).toEqual([]);
    expect(test.adapter.probeCalls).toBe(1);
    expect(test.adapter.lastApiKey).toBe('sk-upstream-secret');

    const deleted = await test.app.inject({
      method: 'DELETE', url: '/api/v1/rates/rate_probe', headers,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(test.context.database.db.select().from(ratesCurrent).get()?.removedAt).not.toBeNull();
    expect(test.context.database.db.select().from(rateProbeConfigs).get()).toBeUndefined();
    expect(test.context.database.db.select().from(rateProbeRuns).get()).toMatchObject({ configId: null });
    expect(test.context.database.db.select().from(rateHistory).get()).toMatchObject({
      changeType: 'removed', rateKey: 'group:1:effective',
    });
    expect(JSON.parse(test.context.database.db.select().from(sites).get()!.excludedRateGroupIdsJson)).toContain('12');
    expect(test.context.database.db.select().from(credentials)
      .where(eq(credentials.credentialType, 'rate_probe:rate_probe:api_key')).get()?.revokedAt).not.toBeNull();

    const rates = await test.app.inject({
      method: 'GET', url: '/api/v1/rates?page=1&page_size=20', headers: { cookie: test.cookie },
    });
    expect(rates.json().data.items).toEqual([]);
  });

  it('stores custom keys encrypted and returns idempotent heuristic probe evidence', async () => {
    const test = await fixture();
    const headers = { cookie: test.cookie, 'x-csrf-token': test.csrf };
    const forbidden = await test.app.inject({
      method: 'PUT', url: '/api/v1/rates/rate_probe/probe-config', headers: { cookie: test.cookie },
      payload: { model_mode: 'manual', model: 'gpt-5.6-sol', use_site_api_key: false, max_output_tokens: 96 },
    });
    expect(forbidden.statusCode).toBe(403);

    const saved = await test.app.inject({
      method: 'PUT', url: '/api/v1/rates/rate_probe/probe-config', headers,
      payload: { model_mode: 'manual', model: 'gpt-5.6-sol', use_site_api_key: false, custom_api_key: 'sk-custom-secret', max_output_tokens: 96, timeout_seconds: 47 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ custom_api_key_present: true, use_site_api_key: false, timeout_seconds: 47 });
    expect(JSON.stringify(saved.json())).not.toContain('sk-custom-secret');
    const storedCredential = test.context.database.db.select().from(credentials)
      .where(eq(credentials.credentialType, 'rate_probe:rate_probe:api_key')).get()!;
    expect(storedCredential.ciphertext.toString('utf8')).not.toContain('sk-custom-secret');

    const replacedSiteCredentials = await test.app.inject({
      method: 'PUT', url: '/api/v1/sites/site_probe/credentials', headers,
      payload: { mode: 'token', values: { api_key: 'new-site-key' } },
    });
    expect(replacedSiteCredentials.statusCode, replacedSiteCredentials.body).toBe(200);
    expect(test.context.database.db.select().from(credentials)
      .where(eq(credentials.credentialType, 'rate_probe:rate_probe:api_key')).get()?.revokedAt).toBeNull();

    const models = await test.app.inject({ method: 'POST', url: '/api/v1/rates/rate_probe/probe-models', headers });
    expect(models.json().data.items).toEqual([{ id: 'gpt-5.6-sol' }, { id: 'gpt-test' }]);
    expect(test.adapter.lastApiKey).toBe('sk-custom-secret');
    expect(test.adapter.lastTimeoutMs).toBe(47_000);

    const probeHeaders = { ...headers, 'idempotency-key': 'probe-once' };
    const first = await test.app.inject({ method: 'POST', url: '/api/v1/rates/rate_probe/probe', headers: probeHeaders, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({
      status: 'success', requested_model: 'gpt-5.6-sol', model_identity: 'declared_match',
      prompt_integrity: 'no_interference_observed', knowledge_probe: 'weak_consistency',
      cached_input_tokens: 40, reasoning_tokens: 12, expected_input_tokens: 83,
      input_token_delta: 117, input_token_assessment: 'higher_than_expected',
      tool_calls_observed: false, tps: 31.99,
      evidence: {
        request_protocol: 'responses',
        request_path: '/v1/responses',
        client_tools_declared: false,
        client_tool_choice: 'none',
        prompt_template_id: 'relay-monitor-diagnostic-v1',
        timeout_seconds: 47,
        upstream_tools_observed: false,
      },
    });
    expect(test.adapter.lastTimeoutMs).toBe(47_000);
    const replay = await test.app.inject({ method: 'POST', url: '/api/v1/rates/rate_probe/probe', headers: probeHeaders, payload: {} });
    expect(replay.json()).toEqual(first.json());
    expect(test.adapter.probeCalls).toBe(1);

    const rates = await test.app.inject({ method: 'GET', url: '/api/v1/rates?page=1&page_size=20', headers: { cookie: test.cookie } });
    expect(rates.json().data.items[0].latest_probe).toMatchObject({ id: first.json().data.id, status: 'success' });
    expect(test.context.database.db.select().from(ratesCurrent).get()?.probeStatus).toBe('not_configured');
    const persisted = test.context.database.db.select().from(rateProbeRuns).get()!;
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(test.adapter.lastCanary);
    expect(serialized).not.toContain('Landry');
    expect(serialized).not.toContain('sk-custom-secret');

    const removedKey = await test.app.inject({
      method: 'PUT', url: '/api/v1/rates/rate_probe/probe-config', headers,
      payload: { model_mode: 'manual', model: 'gpt-5.6-sol', use_site_api_key: false, custom_api_key: null, max_output_tokens: 96 },
    });
    expect(removedKey.statusCode, removedKey.body).toBe(200);
    expect(removedKey.json().data).toMatchObject({
      custom_api_key_present: false,
      timeout_seconds: 47,
    });
    expect(test.context.database.db.select().from(credentials)
      .where(eq(credentials.credentialType, 'rate_probe:rate_probe:api_key')).get()?.revokedAt).not.toBeNull();

    test.context.database.db.insert(notificationRules).values({
      id: 'rule_probe_interrupt',
      name: 'Probe interruptions',
      type: 'monitor_events',
      severity: 'warning',
      currentRevisionId: 'revision_probe_interrupt',
    }).run();
    test.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_probe_interrupt',
      ruleId: 'rule_probe_interrupt',
      revisionNumber: 1,
      conditionJson: JSON.stringify({ event_types: ['probe.failed', 'probe.recovered'] }),
      triggerConfirmCount: 1,
      recoveryConfirmCount: 1,
    }).run();
    const failedIncidentCountBeforeStaleRecovery = test.context.database.db.select().from(incidents)
      .where(eq(incidents.eventType, 'probe.failed')).all().length;
    test.context.database.db.insert(rateProbeRuns).values({
      id: 'proberun_stale',
      rateId: 'rate_probe',
      siteId: 'site_probe',
      status: 'running',
      requestedModel: 'gpt-test',
      startedAt: '2000-01-01T00:00:00.000Z',
    }).run();
    const recovered = await test.app.inject({
      method: 'GET', url: '/api/v1/rates/rate_probe/probes?page=1&page_size=20',
      headers: { cookie: test.cookie },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().data.items).toContainEqual(expect.objectContaining({
      id: 'proberun_stale',
      status: 'failed',
      error_code: 'RATE_PROBE_INTERRUPTED',
    }));
    expect(test.context.database.db.select().from(incidents)
      .where(eq(incidents.eventType, 'probe.failed')).all()).toHaveLength(failedIncidentCountBeforeStaleRecovery);

    test.context.database.db.insert(rateProbeRuns).values({
      id: 'proberun_recent',
      rateId: 'rate_probe',
      siteId: 'site_probe',
      status: 'running',
      requestedModel: 'gpt-test',
      startedAt: new Date().toISOString(),
    }).run();
    const concurrent = await test.app.inject({
      method: 'POST', url: '/api/v1/rates/rate_probe/probe',
      headers: { ...headers, 'idempotency-key': 'probe-concurrent' },
      payload: {},
    });
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json().error.code).toBe('RATE_PROBE_IN_PROGRESS');
  });
});
