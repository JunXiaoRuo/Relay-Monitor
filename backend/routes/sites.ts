import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  min,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type {
  AuthResult,
  CredentialInput,
  RelayAdapter,
} from '../adapters/index.js';
import type { AppContext } from '../context.js';
import {
  balancesCurrent,
  healthChecks,
  monitorConfigs,
  monitorJobs,
  rateProbeConfigs,
  rateProbeRuns,
  ratesCurrent,
  siteCapabilities,
  siteProbeKeyMappings,
  sites,
  type Site,
} from '../db/index.js';
import {
  API_MAX_PAGE_SIZE,
  DEFAULT_MONITOR_INTERVAL_SECONDS,
  DEFAULT_MONITOR_RETRY_COUNT,
  DEFAULT_MONITOR_RETRY_INTERVAL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULE_JITTER_PERCENT,
  MONITOR_TYPES,
  type MonitorType,
} from '../../shared/constants.js';
import { monitorConfigInputSchema, monitorTypeSchema } from '../../shared/schemas.js';
import { success } from '../core/api-response.js';
import { recordAudit } from '../core/audit.js';
import { AppError } from '../core/errors.js';
import { createId } from '../core/ids.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from '../core/idempotency.js';
import { createSafeFetchContext } from '../core/safe-fetch.js';
import {
  credentialPresence,
  loadCredentials,
  revokeCredentials,
  storeCredentials,
} from '../services/credentials.js';
import {
  listUpstreamProbeApiKeys,
  maskedProbeApiKey,
  persistResolvedProbeKeyMappings,
  revokeManagedProbeKeysForSite,
  revokeManagedProbeKeysForGroups,
  resolveProbeKeyMappings,
  savedSiteCredentials,
  withUserAdapter,
  type ProbeKeyMappingInput,
} from '../services/upstream-probe-keys.js';
import {
  rateGroupId,
  siteRateGroupScope,
  updateSiteRateGroupScope,
} from '../services/rate-scope.js';

const credentialValuesSchema = z.record(z.string().min(1).max(80), z.union([
  z.string().max(16_384),
  z.boolean(),
]));

const credentialInputSchema = z.object({
  mode: z.enum(['password', 'token']),
  values: credentialValuesSchema,
  persist_keys: z.array(z.string().min(1).max(80)).max(32).optional(),
});

const monitorOverridesSchema = z.record(
  monitorTypeSchema,
  monitorConfigInputSchema.partial().optional(),
).optional();

const rateGroupScopeSchema = z.object({
  mode: z.enum(['all', 'selected']),
  group_ids: z.array(z.string().trim().regex(/^\d+$/).max(40)).max(500),
});

const probeKeyMappingSchema = z.object({
  group_id: z.string().trim().regex(/^\d+$/).max(40),
  mode: z.enum(['existing', 'auto_create']),
  upstream_key_id: z.string().trim().regex(/^\d+$/).max(40).optional(),
  quota_limit: z.number().positive().max(10).optional(),
  expires_in_seconds: z.number().int().min(86_400).max(30 * 86_400).optional(),
}).superRefine((value, ctx) => {
  if (value.mode === 'existing' && !value.upstream_key_id) {
    ctx.addIssue({ code: 'custom', path: ['upstream_key_id'], message: 'Existing key mode requires upstream_key_id' });
  }
});

const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapter_type: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  base_url: z.string().url().max(2_048),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  notes: z.string().max(4_000).optional(),
  tls_verify: z.boolean().default(true),
  credentials: credentialInputSchema.optional(),
  monitors: monitorOverridesSchema,
  rate_group_scope: rateGroupScopeSchema.default({ mode: 'all', group_ids: [] }),
  probe_key_mappings: z.array(probeKeyMappingSchema).max(100).default([]),
}).superRefine((value, ctx) => {
  const seenMappings = new Set<string>();
  value.probe_key_mappings.forEach((mapping, index) => {
    if (seenMappings.has(mapping.group_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['probe_key_mappings', index, 'group_id'],
        message: '每个倍率分组只能绑定一个实测 Key',
      });
    }
    seenMappings.add(mapping.group_id);
  });
  if (value.rate_group_scope.mode !== 'selected') return;
  const selected = new Set(value.rate_group_scope.group_ids);
  value.probe_key_mappings.forEach((mapping, index) => {
    if (!selected.has(mapping.group_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['probe_key_mappings', index, 'group_id'],
        message: '实测 Key 所属分组必须包含在已选择的倍率分组中',
      });
    }
  });
});

const updateSiteSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  base_url: z.string().url().max(2_048).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  notes: z.string().max(4_000).nullable().optional(),
  enabled: z.boolean().optional(),
  tls_verify: z.boolean().optional(),
  credentials: credentialInputSchema.optional(),
  monitors: monitorOverridesSchema,
  rate_group_scope: rateGroupScopeSchema.optional(),
});

const siteIdParamsSchema = z.object({ id: z.string().min(1).max(80) });

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function publicCredentialPresence(context: AppContext, siteId: string): string[] {
  return credentialPresence(context.database, siteId)
    .filter((key) => !key.startsWith('rate_probe:') && !key.startsWith('site_probe_group:'));
}

function safeFetchOptions(context: AppContext) {
  return {
    allowHttp: !context.config.isProduction,
    allowedCidrs: context.config.outboundAllowedCidrs,
  };
}

function credentialInput(body: z.infer<typeof credentialInputSchema>): CredentialInput {
  return {
    mode: body.mode,
    values: body.values,
    ...(body.persist_keys ? { persistKeys: body.persist_keys } : {}),
  };
}

function persistableKeys(adapter: RelayAdapter, input: CredentialInput): string[] {
  const allowed = new Set(
    adapter.manifest().credentialFields
      .filter((field) => field.persistable !== false)
      .map((field) => field.key),
  );
  if (input.persistKeys) return input.persistKeys.filter((key) => allowed.has(key));
  return Object.keys(input.values).filter((key) => allowed.has(key) && key !== 'password');
}

async function authenticate(
  context: AppContext,
  adapter: RelayAdapter,
  siteId: string,
  baseUrl: string,
  input: CredentialInput,
): Promise<AuthResult> {
  const outbound = await createSafeFetchContext(baseUrl, safeFetchOptions(context));
  try {
    return await adapter.authenticate({
      siteId,
      baseUrl: outbound.baseUrl,
      fetch: outbound.fetch,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_SECONDS * 1_000,
    }, input);
  } finally {
    await outbound.close();
  }
}

async function discoverCapabilities(
  context: AppContext,
  adapter: RelayAdapter,
  siteId: string,
  baseUrl: string,
  credentialValues: Record<string, string | undefined>,
) {
  const outbound = await createSafeFetchContext(baseUrl, safeFetchOptions(context));
  try {
    return await adapter.discover({
      siteId,
      baseUrl: outbound.baseUrl,
      credentials: credentialValues,
      fetch: outbound.fetch,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_SECONDS * 1_000,
    });
  } finally {
    await outbound.close();
  }
}

function createMonitorRows(siteId: string, overrides: z.infer<typeof monitorOverridesSchema>) {
  const now = new Date().toISOString();
  return MONITOR_TYPES.map((monitorType) => {
    const override = overrides?.[monitorType];
    const enabled = override?.enabled ?? true;
    return {
      config: {
        id: createId('moncfg'),
        siteId,
        monitorType,
        enabled,
        intervalSeconds: override?.interval_seconds ?? DEFAULT_MONITOR_INTERVAL_SECONDS[monitorType],
        timeoutSeconds: override?.timeout_seconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
        retryCount: override?.retry_count ?? DEFAULT_MONITOR_RETRY_COUNT,
        retryIntervalSeconds: override?.retry_interval_seconds ?? DEFAULT_MONITOR_RETRY_INTERVAL_SECONDS,
        scheduleJitterPercent: override?.schedule_jitter_percent ?? DEFAULT_SCHEDULE_JITTER_PERCENT,
      },
      job: {
        id: createId('job'),
        siteId,
        monitorType,
        state: enabled ? 'queued' : 'disabled',
        nextRunAt: now,
      },
    };
  });
}

function siteBase(site: Site, context: AppContext) {
  const balance = context.database.db
    .select()
    .from(balancesCurrent)
    .where(eq(balancesCurrent.siteId, site.id))
    .orderBy(desc(balancesCurrent.lastCheckedAt))
    .get();
  const health = context.database.db
    .select()
    .from(healthChecks)
    .where(eq(healthChecks.siteId, site.id))
    .orderBy(desc(healthChecks.checkedAt))
    .get();
  const rateCount = context.database.db
    .select({ value: count() })
    .from(ratesCurrent)
    .where(and(eq(ratesCurrent.siteId, site.id), isNull(ratesCurrent.removedAt)))
    .get()?.value ?? 0;
  const nextCheck = context.database.db
    .select({ value: min(monitorJobs.nextRunAt) })
    .from(monitorJobs)
    .where(and(eq(monitorJobs.siteId, site.id), inArray(monitorJobs.state, ['queued', 'retry'])))
    .get()?.value ?? null;
  const uptime = context.database.sqlite.prepare(`
    select printf('%.2f', avg(case when success = 1 then 100.0 else 0.0 end)) as value
    from health_checks
    where site_id = ? and checked_at >= ?
  `).get(site.id, new Date(Date.now() - 86_400_000).toISOString()) as { value: string | null } | undefined;

  return {
    id: site.id,
    adapter_type: site.adapterType,
    adapter_version: site.adapterVersion,
    name: site.name,
    base_url: site.baseUrl,
    tags: parseJson<string[]>(site.tagsJson, []),
    notes: site.notes,
    rate_group_scope: {
      mode: siteRateGroupScope(site).mode,
      group_ids: siteRateGroupScope(site).groupIds,
    },
    tls_verify: site.tlsVerify,
    enabled: site.enabled,
    service_status: site.serviceStatus,
    auth_status: site.authStatus,
    credential_status: {
      mode: site.credentialMode,
      present_keys: publicCredentialPresence(context, site.id),
      access_expires_at: site.accessExpiresAt,
    },
    balance: balance ? {
      value: balance.value,
      currency: balance.currency ?? balance.unit,
      balance_key: balance.balanceKey,
      collected_at: balance.lastCheckedAt,
    } : undefined,
    latency_ms: health?.totalMs ?? undefined,
    uptime_24h: uptime?.value ?? '0.00',
    rate_count: rateCount,
    last_success_at: site.lastSuccessAt,
    last_error: site.lastErrorMessage ?? site.lastErrorCode,
    next_check_at: nextCheck,
    created_at: site.createdAt,
    updated_at: site.updatedAt,
  };
}

function groupRateDto(rate: Awaited<ReturnType<RelayAdapter['collectRates']>>['rates'][number]) {
  const attributes = rate.attributes ?? {};
  return {
    id: typeof attributes.group_id === 'string' ? attributes.group_id : rate.rateKey,
    name: rate.name,
    platform: rate.platform ?? null,
    base_rate: typeof attributes.base_rate === 'string' ? attributes.base_rate : rate.value,
    user_rate: typeof attributes.user_rate === 'string' ? attributes.user_rate : null,
    effective_rate: typeof attributes.effective_rate === 'string' ? attributes.effective_rate : rate.value,
  };
}

async function previewAuthenticatedContext(
  context: AppContext,
  body: { adapter_type: string; base_url: string; credentials: z.infer<typeof credentialInputSchema> },
) {
  const adapter = context.adapters.get(body.adapter_type);
  const outbound = await createSafeFetchContext(body.base_url, safeFetchOptions(context));
  const baseUrl = outbound.baseUrl;
  await outbound.close();
  const input = adapter.credentialSchema.parse(credentialInput(body.credentials));
  const result = await authenticate(context, adapter, 'site_preview', baseUrl, input);
  if (result.status !== 'authenticated') {
    throw new AppError('AUTH_INTERACTION_REQUIRED', result.message, 409);
  }
  const values = stringCredentials(input.values);
  values.access_token = result.tokens.accessToken;
  if (result.tokens.refreshToken) values.refresh_token = result.tokens.refreshToken;
  if (result.tokens.expiresAt) values.access_expires_at = result.tokens.expiresAt;
  return { adapter, baseUrl, values };
}

function requireSite(context: AppContext, id: string): Site {
  const site = context.database.db
    .select()
    .from(sites)
    .where(and(eq(sites.id, id), isNull(sites.deletedAt)))
    .get();
  if (!site) throw new AppError('SITE_NOT_FOUND', '中转站不存在', 404);
  return site;
}

function siteDetails(site: Site, context: AppContext) {
  const jobs = new Map(context.database.db
    .select()
    .from(monitorJobs)
    .where(eq(monitorJobs.siteId, site.id))
    .all()
    .map((job) => [job.monitorType, job]));
  const monitors = context.database.db
    .select()
    .from(monitorConfigs)
    .where(eq(monitorConfigs.siteId, site.id))
    .all()
    .map((monitor) => {
      const job = jobs.get(monitor.monitorType);
      return {
      monitor_type: monitor.monitorType,
      enabled: monitor.enabled,
      interval_seconds: monitor.intervalSeconds,
      timeout_seconds: monitor.timeoutSeconds,
      retry_count: monitor.retryCount,
      retry_interval_seconds: monitor.retryIntervalSeconds,
      schedule_jitter_percent: monitor.scheduleJitterPercent,
      ...(job ? {
        runtime: {
          state: job.state,
          attempts: job.attempts,
          next_run_at: job.nextRunAt,
          last_started_at: job.lastStartedAt,
          last_finished_at: job.lastFinishedAt,
          last_success_at: job.lastSuccessAt,
          last_error_code: job.lastErrorCode,
          last_error_message: job.lastErrorMessage,
        },
      } : {}),
    };
    });
  const capabilities = context.database.db
    .select()
    .from(siteCapabilities)
    .where(eq(siteCapabilities.siteId, site.id))
    .all()
    .map((capability) => ({
      key: capability.capabilityKey,
      status: capability.status,
      last_error_code: capability.lastErrorCode,
      detected_at: capability.detectedAt,
    }));
  return { ...siteBase(site, context), monitor_configs: monitors, capabilities };
}

function stringCredentials(values: Record<string, string | boolean | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === undefined ? undefined : String(value)]),
  );
}

export async function registerSiteRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post('/api/v1/sites/discover', {
    schema: {
      tags: ['sites'],
      summary: '安全预探测站点与适配器能力',
      body: z.object({
        adapter_type: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
        base_url: z.string().url().max(2_048),
      }),
    },
  }, async (request) => {
    const adapter = context.adapters.get(request.body.adapter_type);
    const outbound = await createSafeFetchContext(request.body.base_url, safeFetchOptions(context));
    try {
      const discovered = await adapter.discover({
        siteId: 'site_discovery',
        baseUrl: outbound.baseUrl,
        fetch: outbound.fetch,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_SECONDS * 1_000,
      });
      return success(request, {
        base_url: outbound.baseUrl,
        adapter_type: adapter.manifest().adapterType,
        adapter_version: adapter.manifest().adapterVersion,
        capabilities: discovered.capabilities,
      });
    } finally {
      await outbound.close();
    }
  });

  const previewBodySchema = z.object({
    adapter_type: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
    base_url: z.string().url().max(2_048),
    credentials: credentialInputSchema,
  });

  typed.post('/api/v1/sites/groups/discover', {
    schema: { tags: ['sites'], summary: '使用未保存凭据读取可用分组', body: previewBodySchema },
  }, async (request) => {
    const preview = await previewAuthenticatedContext(context, request.body);
    const snapshot = await withUserAdapter(context, {
      adapter: preview.adapter,
      siteId: 'site_preview',
      baseUrl: preview.baseUrl,
      credentials: preview.values,
    }, (adapter, siteContext) => adapter.collectRates(siteContext));
    return success(request, {
      items: snapshot.rates.filter((rate) => rate.rateKind === 'group').map(groupRateDto),
    });
  });

  typed.post('/api/v1/sites/api-keys/discover', {
    schema: { tags: ['sites'], summary: '使用未保存凭据读取用户 API Key', body: previewBodySchema },
  }, async (request) => {
    const preview = await previewAuthenticatedContext(context, request.body);
    const keys = await listUpstreamProbeApiKeys(context, {
      adapter: preview.adapter,
      siteId: 'site_preview',
      baseUrl: preview.baseUrl,
      credentials: preview.values,
    });
    return success(request, { items: keys.map(maskedProbeApiKey) });
  });

  typed.post('/api/v1/sites', {
    schema: { tags: ['sites'], summary: '添加中转站', body: createSiteSchema },
  }, async (request, reply) => {
    const idempotency = claimIdempotencyKey(context.database, {
      scope: `${request.relayAdmin?.id ?? 'anonymous'}:POST:/api/v1/sites`,
      key: request.headers['idempotency-key'],
      request: request.body,
    });
    if (idempotency.kind === 'replay') {
      reply.code(idempotency.responseStatus);
      return idempotency.responseBody;
    }

    try {
    const adapter = context.adapters.get(request.body.adapter_type);
    const hasAutoCreateMapping = request.body.probe_key_mappings.some((mapping) => mapping.mode === 'auto_create');
    if (hasAutoCreateMapping && idempotency.kind !== 'acquired') {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '自动创建上游 Key 必须提供 Idempotency-Key', 400);
    }
    const siteId = idempotency.kind === 'acquired'
      ? idempotency.id.replace(/^idem_/, 'site_')
      : createId('site');
    const outbound = await createSafeFetchContext(request.body.base_url, safeFetchOptions(context));
    const baseUrl = outbound.baseUrl;
    await outbound.close();

    let input: CredentialInput | undefined;
    let authResult: AuthResult | undefined;
    if (request.body.credentials) {
      input = adapter.credentialSchema.parse(credentialInput(request.body.credentials));
      authResult = await authenticate(context, adapter, siteId, baseUrl, input);
    }

    const values = input ? { ...input.values } : {};
    const keys = input ? persistableKeys(adapter, input) : [];
    if (authResult?.status === 'authenticated') {
      values.access_token = authResult.tokens.accessToken;
      if (authResult.tokens.refreshToken) values.refresh_token = authResult.tokens.refreshToken;
      if (!keys.includes('access_token')) keys.push('access_token');
      if (authResult.tokens.refreshToken && !keys.includes('refresh_token')) keys.push('refresh_token');
    }
    const resolvedProbeMappings = request.body.probe_key_mappings.length > 0
      ? authResult?.status === 'authenticated'
        ? await resolveProbeKeyMappings(context, {
          adapter,
          siteId,
          baseUrl,
          credentials: stringCredentials(values),
          ...(typeof request.headers['idempotency-key'] === 'string'
            ? { idempotencyKey: request.headers['idempotency-key'] }
            : {}),
          mappings: request.body.probe_key_mappings.map((mapping): ProbeKeyMappingInput => ({
            groupId: mapping.group_id,
            mode: mapping.mode,
            ...(mapping.upstream_key_id ? { upstreamKeyId: mapping.upstream_key_id } : {}),
            ...(mapping.quota_limit === undefined ? {} : { quotaLimit: mapping.quota_limit }),
            ...(mapping.expires_in_seconds === undefined ? {} : { expiresInSeconds: mapping.expires_in_seconds }),
          })),
        })
        : (() => { throw new AppError('AUTH_REQUIRED_FOR_PROBE_KEYS', '配置分组测试 Key 前必须完成站点认证', 409); })()
      : [];
    const capabilities = await discoverCapabilities(
      context,
      adapter,
      siteId,
      baseUrl,
      stringCredentials(values),
    );
    const manifest = adapter.manifest();
    const now = new Date().toISOString();
    const monitorRows = createMonitorRows(siteId, request.body.monitors);
    const authStatus = authResult?.status === 'authenticated'
      ? 'authenticated'
      : authResult?.status === 'interaction_required'
        ? 'interaction_required'
        : 'unknown';

    let response: unknown;
    context.database.sqlite.transaction(() => {
      context.database.db.insert(sites).values({
        id: siteId,
        adapterType: manifest.adapterType,
        adapterVersion: manifest.adapterVersion,
        adapterSchemaVersion: String(manifest.adapterSchemaVersion),
        name: request.body.name,
        baseUrl,
        tagsJson: JSON.stringify(request.body.tags),
        notes: request.body.notes ?? null,
        rateGroupScopeMode: request.body.rate_group_scope.mode,
        rateGroupIdsJson: JSON.stringify(request.body.rate_group_scope.group_ids),
        tlsVerify: request.body.tls_verify,
        serviceStatus: 'unknown',
        authStatus,
        credentialMode: input?.mode ?? null,
        accessExpiresAt: authResult?.status === 'authenticated'
          ? authResult.tokens.expiresAt ?? null
          : null,
        updatedAt: now,
      }).run();
      for (const row of monitorRows) {
        context.database.db.insert(monitorConfigs).values(row.config).run();
        context.database.db.insert(monitorJobs).values(row.job).run();
      }
      if (input) {
        storeCredentials(context.database, context.vault, siteId, values, {
          persistKeys: keys,
          expiresAtByKey: authResult?.status === 'authenticated' && authResult.tokens.expiresAt
            ? { access_token: authResult.tokens.expiresAt }
            : {},
        });
      }
      persistResolvedProbeKeyMappings(context, siteId, resolvedProbeMappings);
      for (const [key, capability] of Object.entries(capabilities.capabilities)) {
        context.database.db.insert(siteCapabilities).values({
          id: createId('cap'),
          siteId,
          capabilityKey: key,
          status: capability.status,
          adapterVersion: capabilities.adapterVersion,
          adapterSchemaVersion: String(capabilities.adapterSchemaVersion),
          upstreamVersion: capabilities.upstreamVersion ?? null,
          structureFingerprint: capabilities.responseStructureFingerprint ?? null,
          lastErrorCode: capability.lastErrorCode ?? null,
          detectedAt: capability.checkedAt,
        }).run();
      }
      const created = requireSite(context, siteId);
      response = success(request, {
        ...siteDetails(created, context),
        ...(authResult?.status === 'interaction_required' ? {
          auth_challenge: {
            type: authResult.challenge,
            temporary_token: authResult.temporaryToken,
            masked_identity: authResult.maskedIdentity,
            message: authResult.message,
          },
        } : {}),
      });
      recordAudit(context.database, request, {
        action: 'site.create',
        resourceType: 'site',
        resourceId: siteId,
        metadata: { adapter_type: manifest.adapterType },
      });
      completeIdempotencyKey(context.database, idempotency, {
        responseStatus: 201,
        responseBody: response,
        resourceId: siteId,
      });
    }).immediate();

    reply.code(201);
    return response;
    } catch (error) {
      failIdempotencyKey(context.database, idempotency);
      throw error;
    }
  });

  typed.get('/api/v1/sites', {
    schema: {
      tags: ['sites'],
      summary: '分页查询中转站',
      querystring: z.object({
        page: z.coerce.number().int().min(1).default(1),
        page_size: z.coerce.number().int().min(1).max(API_MAX_PAGE_SIZE).default(50),
        search: z.string().max(120).optional(),
      }),
    },
  }, async (request) => {
    const allSites = context.database.db
      .select()
      .from(sites)
      .where(isNull(sites.deletedAt))
      .orderBy(sites.name)
      .all();
    const search = request.query.search?.trim().toLocaleLowerCase();
    const filtered = search
      ? allSites.filter((site) => site.name.toLocaleLowerCase().includes(search) || site.baseUrl.toLocaleLowerCase().includes(search))
      : allSites;
    const offset = (request.query.page - 1) * request.query.page_size;
    return success(request, {
      items: filtered.slice(offset, offset + request.query.page_size).map((site) => siteBase(site, context)),
      page: request.query.page,
      page_size: request.query.page_size,
      total: filtered.length,
    });
  });

  typed.get('/api/v1/sites/:id', {
    schema: { tags: ['sites'], summary: '读取中转站详情', params: siteIdParamsSchema },
  }, async (request) => success(request, siteDetails(requireSite(context, request.params.id), context)));

  typed.get('/api/v1/sites/:id/groups', {
    schema: { tags: ['sites'], summary: '读取站点当前可用分组', params: siteIdParamsSchema },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const adapter = context.adapters.get(site.adapterType);
    const values = savedSiteCredentials(context, site);
    if (site.accessExpiresAt) values.access_expires_at = site.accessExpiresAt;
    const snapshot = await withUserAdapter(context, {
      adapter,
      siteId: site.id,
      baseUrl: site.baseUrl,
      credentials: values,
      persistAuthUpdates: true,
    }, (current, siteContext) => current.collectRates(siteContext));
    return success(request, {
      items: snapshot.rates.filter((rate) => rate.rateKind === 'group').map(groupRateDto),
    });
  });

  typed.get('/api/v1/sites/:id/upstream-api-keys', {
    schema: { tags: ['sites'], summary: '读取用户上游 API Key 掩码元数据', params: siteIdParamsSchema },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const values = savedSiteCredentials(context, site);
    if (site.accessExpiresAt) values.access_expires_at = site.accessExpiresAt;
    const keys = await listUpstreamProbeApiKeys(context, {
      adapter: context.adapters.get(site.adapterType),
      siteId: site.id,
      baseUrl: site.baseUrl,
      credentials: values,
      persistAuthUpdates: true,
    });
    return success(request, { items: keys.map(maskedProbeApiKey) });
  });

  typed.post('/api/v1/sites/:id/upstream-api-keys', {
    schema: {
      tags: ['sites'],
      summary: '创建并安全绑定分组探测 API Key',
      params: siteIdParamsSchema,
      body: z.object({
        group_id: z.string().trim().regex(/^\d+$/).max(40),
        quota_limit: z.number().positive().max(10).optional(),
        expires_in_seconds: z.number().int().min(86_400).max(30 * 86_400).optional(),
      }),
    },
  }, async (request, reply) => {
    const idempotency = claimIdempotencyKey(context.database, {
      scope: `${request.relayAdmin?.id ?? 'anonymous'}:POST:/api/v1/sites/${request.params.id}/upstream-api-keys`,
      key: request.headers['idempotency-key'],
      request: { site_id: request.params.id, ...request.body },
    });
    if (idempotency.kind === 'replay') {
      reply.code(idempotency.responseStatus);
      return idempotency.responseBody;
    }
    if (idempotency.kind !== 'acquired') {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '自动创建上游 Key 必须提供 Idempotency-Key', 400);
    }
    try {
      const site = requireSite(context, request.params.id);
      const resolved = await resolveProbeKeyMappings(context, {
        adapter: context.adapters.get(site.adapterType),
        siteId: site.id,
        baseUrl: site.baseUrl,
        credentials: savedSiteCredentials(context, site),
        persistAuthUpdates: true,
        idempotencyKey: request.headers['idempotency-key'] as string,
        mappings: [{
          groupId: request.body.group_id,
          mode: 'auto_create',
          ...(request.body.quota_limit === undefined ? {} : { quotaLimit: request.body.quota_limit }),
          ...(request.body.expires_in_seconds === undefined
            ? {}
            : { expiresInSeconds: request.body.expires_in_seconds }),
        }],
      });
      const item = resolved[0]!;
      let response: unknown;
      context.database.sqlite.transaction(() => {
        persistResolvedProbeKeyMappings(context, site.id, resolved);
        response = success(request, maskedProbeApiKey(item.key));
        recordAudit(context.database, request, {
          action: 'site.probe_key_create',
          resourceType: 'site',
          resourceId: site.id,
          metadata: { group_id: item.groupId, upstream_key_id: item.key.id },
        });
        completeIdempotencyKey(context.database, idempotency, {
          responseStatus: 201,
          responseBody: response,
          resourceId: item.key.id,
        });
      }).immediate();
      reply.code(201);
      return response;
    } catch (error) {
      failIdempotencyKey(context.database, idempotency);
      throw error;
    }
  });

  typed.get('/api/v1/sites/:id/capabilities', {
    schema: { tags: ['sites'], summary: '读取站点能力探测结果', params: siteIdParamsSchema },
  }, async (request) => {
    requireSite(context, request.params.id);
    const items = context.database.db.select().from(siteCapabilities)
      .where(eq(siteCapabilities.siteId, request.params.id)).all();
    return success(request, items.map((item) => ({
      key: item.capabilityKey,
      status: item.status,
      adapter_version: item.adapterVersion,
      upstream_version: item.upstreamVersion,
      last_error_code: item.lastErrorCode,
      detected_at: item.detectedAt,
    })));
  });

  typed.route({
    method: ['PATCH', 'PUT'],
    url: '/api/v1/sites/:id',
    schema: {
      tags: ['sites'],
      summary: '更新中转站',
      params: siteIdParamsSchema,
      body: updateSiteSchema,
    },
    handler: async (request) => {
    const site = requireSite(context, request.params.id);
    let baseUrl = request.body.base_url;
    if (baseUrl) {
      const outbound = await createSafeFetchContext(baseUrl, safeFetchOptions(context));
      baseUrl = outbound.baseUrl;
      await outbound.close();
    }
    const effectiveBaseUrl = baseUrl ?? site.baseUrl;
    const originChanged = Boolean(baseUrl && new URL(baseUrl).origin !== new URL(site.baseUrl).origin);
    if (originChanged && !request.body.credentials) {
      throw new AppError(
        'CREDENTIALS_REQUIRED_FOR_ORIGIN_CHANGE',
        '修改为不同来源的中转地址时必须重新提供并验证凭据',
        400,
      );
    }
    if (originChanged) {
      const runningProbe = context.database.db.select({ id: rateProbeRuns.id })
        .from(rateProbeRuns)
        .where(and(eq(rateProbeRuns.siteId, site.id), eq(rateProbeRuns.status, 'running')))
        .get();
      if (runningProbe) {
        throw new AppError('RATE_PROBE_IN_PROGRESS', '站点模型实测运行期间不能修改中转来源', 409);
      }
    }
    const adapter = context.adapters.get(site.adapterType);
    let credentialValues: Record<string, string | boolean | undefined> | undefined;
    let credentialKeys: string[] = [];
    let credentialResult: AuthResult | undefined;
    let credentialMode: CredentialInput['mode'] | undefined;
    if (request.body.credentials) {
      const input = adapter.credentialSchema.parse(credentialInput(request.body.credentials));
      credentialMode = input.mode;
      credentialResult = await authenticate(context, adapter, site.id, effectiveBaseUrl, input);
      credentialValues = { ...input.values };
      credentialKeys = persistableKeys(adapter, input);
      if (credentialResult.status === 'authenticated') {
        credentialValues.access_token = credentialResult.tokens.accessToken;
        if (credentialResult.tokens.refreshToken) credentialValues.refresh_token = credentialResult.tokens.refreshToken;
        if (!credentialKeys.includes('access_token')) credentialKeys.push('access_token');
        if (credentialResult.tokens.refreshToken && !credentialKeys.includes('refresh_token')) {
          credentialKeys.push('refresh_token');
        }
      }
    }
    if (originChanged && credentialResult?.status !== 'authenticated') {
      throw new AppError(
        'AUTH_REQUIRED_FOR_ORIGIN_CHANGE',
        '新中转地址的凭据验证成功后才能修改来源',
        409,
      );
    }
    if (originChanged) await revokeManagedProbeKeysForSite(context, site);
    if (!originChanged && request.body.rate_group_scope?.mode === 'selected') {
      const selectedGroups = new Set(request.body.rate_group_scope.group_ids);
      const currentGroups = context.database.db.select({ attributesJson: ratesCurrent.attributesJson })
        .from(ratesCurrent)
        .where(eq(ratesCurrent.siteId, site.id)).all()
        .map((rate) => rateGroupId(rate.attributesJson))
        .filter((groupId): groupId is string => groupId !== null);
      currentGroups.push(...siteRateGroupScope(site).groupIds);
      currentGroups.push(...context.database.db.select({ groupId: siteProbeKeyMappings.groupId })
        .from(siteProbeKeyMappings)
        .where(eq(siteProbeKeyMappings.siteId, site.id)).all()
        .map((mapping) => mapping.groupId));
      const groupsToRemove = [...new Set(currentGroups.filter((groupId) => !selectedGroups.has(groupId)))];
      if (groupsToRemove.length > 0) {
        const runningProbe = context.database.db.select({ id: rateProbeRuns.id })
          .from(rateProbeRuns)
          .where(and(eq(rateProbeRuns.siteId, site.id), eq(rateProbeRuns.status, 'running')))
          .get();
        if (runningProbe) {
          throw new AppError('RATE_PROBE_IN_PROGRESS', '站点模型实测运行期间不能移除倍率分组', 409);
        }
      }
      await revokeManagedProbeKeysForGroups(
        context,
        site,
        groupsToRemove,
      );
    }
    const now = new Date().toISOString();
    context.database.sqlite.transaction(() => {
      context.database.db.update(sites).set({
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(request.body.tags === undefined ? {} : { tagsJson: JSON.stringify(request.body.tags) }),
        ...(request.body.notes === undefined ? {} : { notes: request.body.notes }),
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
        ...(request.body.tls_verify === undefined ? {} : { tlsVerify: request.body.tls_verify }),
        updatedAt: now,
      }).where(eq(sites.id, site.id)).run();

      if (request.body.rate_group_scope) {
        updateSiteRateGroupScope(context, site, {
          mode: request.body.rate_group_scope.mode,
          groupIds: request.body.rate_group_scope.group_ids,
        }, now);
      }

      if (originChanged) {
        const internalCredentialKeys = credentialPresence(context.database, site.id)
          .filter((key) => key.startsWith('rate_probe:') || key.startsWith('site_probe_group:'));
        revokeCredentials(context.database, site.id, internalCredentialKeys);
        context.database.db.delete(siteProbeKeyMappings)
          .where(eq(siteProbeKeyMappings.siteId, site.id)).run();
        context.database.db.delete(rateProbeConfigs)
          .where(eq(rateProbeConfigs.siteId, site.id)).run();
        context.database.db.update(ratesCurrent).set({
          metadataStatus: 'unavailable',
          removedAt: now,
          candidateValue: null,
          candidateCount: 0,
          updatedAt: now,
        }).where(eq(ratesCurrent.siteId, site.id)).run();
      }

      if (credentialValues && credentialMode && credentialResult) {
        const replaceableKeys = credentialPresence(context.database, site.id)
          .filter((key) => !key.startsWith('rate_probe:') && !key.startsWith('site_probe_group:'));
        revokeCredentials(context.database, site.id, replaceableKeys);
        storeCredentials(context.database, context.vault, site.id, credentialValues, {
          persistKeys: credentialKeys,
          expiresAtByKey: credentialResult.status === 'authenticated' && credentialResult.tokens.expiresAt
            ? { access_token: credentialResult.tokens.expiresAt }
            : {},
        });
        context.database.db.update(sites).set({
          credentialMode,
          authStatus: credentialResult.status === 'authenticated' ? 'authenticated' : 'interaction_required',
          accessExpiresAt: credentialResult.status === 'authenticated'
            ? credentialResult.tokens.expiresAt ?? null
            : null,
          updatedAt: now,
        }).where(eq(sites.id, site.id)).run();
      }

      for (const [monitorType, override] of Object.entries(request.body.monitors ?? {})) {
        if (!override) continue;
        const config = context.database.db.select().from(monitorConfigs).where(and(
          eq(monitorConfigs.siteId, site.id),
          eq(monitorConfigs.monitorType, monitorType),
        )).get();
        const job = context.database.db.select().from(monitorJobs).where(and(
          eq(monitorJobs.siteId, site.id),
          eq(monitorJobs.monitorType, monitorType),
        )).get();
        if (!config || !job) continue;
        const monitorEnabled = override.enabled ?? config.enabled;
        context.database.db.update(monitorConfigs).set({
          enabled: monitorEnabled,
          intervalSeconds: override.interval_seconds ?? config.intervalSeconds,
          timeoutSeconds: override.timeout_seconds ?? config.timeoutSeconds,
          retryCount: override.retry_count ?? config.retryCount,
          retryIntervalSeconds: override.retry_interval_seconds ?? config.retryIntervalSeconds,
          scheduleJitterPercent: override.schedule_jitter_percent ?? config.scheduleJitterPercent,
          updatedAt: now,
        }).where(eq(monitorConfigs.id, config.id)).run();
        const shouldRun = (request.body.enabled ?? site.enabled) && monitorEnabled;
        context.database.db.update(monitorJobs).set(job.state === 'running' ? {
          runRequested: shouldRun,
          updatedAt: now,
        } : {
          state: shouldRun ? 'queued' : 'disabled',
          nextRunAt: shouldRun ? now : job.nextRunAt,
          leaseOwner: null,
          leaseUntil: null,
          attempts: shouldRun ? 0 : job.attempts,
          retryAfter: null,
          runRequested: false,
          updatedAt: now,
        }).where(eq(monitorJobs.id, job.id)).run();
      }

      if (request.body.enabled !== undefined) {
        const configs = context.database.db.select().from(monitorConfigs)
          .where(eq(monitorConfigs.siteId, site.id)).all();
        const enabledByType = new Map(configs.map((config) => [config.monitorType, config.enabled]));
        const jobs = context.database.db.select().from(monitorJobs)
          .where(eq(monitorJobs.siteId, site.id)).all();
        for (const job of jobs) {
          const shouldRun = request.body.enabled && enabledByType.get(job.monitorType) === true;
          context.database.db.update(monitorJobs).set(job.state === 'running' ? {
            runRequested: shouldRun,
            updatedAt: now,
          } : {
            state: shouldRun ? 'queued' : 'disabled',
            nextRunAt: shouldRun ? now : job.nextRunAt,
            leaseOwner: null,
            leaseUntil: null,
            attempts: shouldRun ? 0 : job.attempts,
            runRequested: false,
            updatedAt: now,
          }).where(eq(monitorJobs.id, job.id)).run();
        }
      }

      recordAudit(context.database, request, {
        action: 'site.update', resourceType: 'site', resourceId: site.id,
      });
    })();
    return success(request, siteDetails(requireSite(context, site.id), context));
    },
  });

  typed.delete('/api/v1/sites/:id', {
    schema: { tags: ['sites'], summary: '软删除中转站', params: siteIdParamsSchema },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    await revokeManagedProbeKeysForSite(context, site);
    const now = new Date().toISOString();
    context.database.sqlite.transaction(() => {
      context.database.db.update(sites).set({
        enabled: false,
        authStatus: 'disabled',
        deletedAt: now,
        updatedAt: now,
      }).where(eq(sites.id, site.id)).run();
      context.database.db.update(monitorConfigs).set({ enabled: false, updatedAt: now })
        .where(eq(monitorConfigs.siteId, site.id)).run();
      const jobs = context.database.db.select().from(monitorJobs)
        .where(eq(monitorJobs.siteId, site.id)).all();
      for (const job of jobs) {
        context.database.db.update(monitorJobs).set(job.state === 'running' ? {
          runRequested: false,
          updatedAt: now,
        } : {
          state: 'disabled',
          leaseOwner: null,
          leaseUntil: null,
          runRequested: false,
          updatedAt: now,
        }).where(eq(monitorJobs.id, job.id)).run();
      }
      revokeCredentials(context.database, site.id);
      recordAudit(context.database, request, {
        action: 'site.soft_delete', resourceType: 'site', resourceId: site.id,
      });
    }).immediate();
    return success(request, null);
  });

  typed.put('/api/v1/sites/:id/credentials', {
    schema: {
      tags: ['sites'], summary: '替换并验证站点凭据', params: siteIdParamsSchema, body: credentialInputSchema,
    },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const adapter = context.adapters.get(site.adapterType);
    const input = adapter.credentialSchema.parse(credentialInput(request.body));
    const result = await authenticate(context, adapter, site.id, site.baseUrl, input);
    const values = { ...input.values };
    const keys = persistableKeys(adapter, input);
    if (result.status === 'authenticated') {
      values.access_token = result.tokens.accessToken;
      if (result.tokens.refreshToken) values.refresh_token = result.tokens.refreshToken;
      if (!keys.includes('access_token')) keys.push('access_token');
      if (result.tokens.refreshToken && !keys.includes('refresh_token')) keys.push('refresh_token');
    }
    context.database.sqlite.transaction(() => {
      const replaceableKeys = credentialPresence(context.database, site.id)
        .filter((key) => !key.startsWith('rate_probe:') && !key.startsWith('site_probe_group:'));
      revokeCredentials(context.database, site.id, replaceableKeys);
      storeCredentials(context.database, context.vault, site.id, values, {
        persistKeys: keys,
        expiresAtByKey: result.status === 'authenticated' && result.tokens.expiresAt
          ? { access_token: result.tokens.expiresAt }
          : {},
      });
      context.database.db.update(sites).set({
        credentialMode: input.mode,
        authStatus: result.status === 'authenticated' ? 'authenticated' : 'interaction_required',
        accessExpiresAt: result.status === 'authenticated' ? result.tokens.expiresAt ?? null : null,
        updatedAt: new Date().toISOString(),
      }).where(eq(sites.id, site.id)).run();
    })();
    recordAudit(context.database, request, {
      action: 'site.credentials_replace', resourceType: 'site', resourceId: site.id,
      metadata: { present_keys: keys },
    });
    return success(request, {
      status: result.status,
      challenge: result.status === 'interaction_required' ? result.challenge : null,
      present_keys: publicCredentialPresence(context, site.id),
    });
  });

  typed.post('/api/v1/sites/:id/auth/test', {
    schema: { tags: ['sites'], summary: '测试已保存的站点认证', params: siteIdParamsSchema },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const adapter = context.adapters.get(site.adapterType);
    const values = loadCredentials(context.database, context.vault, site.id);
    const mode = site.credentialMode === 'password' ? 'password' : 'token';
    const result = await authenticate(context, adapter, site.id, site.baseUrl, { mode, values });
    if (result.status === 'authenticated') {
      const updateValues = {
        access_token: result.tokens.accessToken,
        ...(result.tokens.refreshToken ? { refresh_token: result.tokens.refreshToken } : {}),
      };
      const accessExpiresAt = result.tokens.expiresAt ?? site.accessExpiresAt;
      context.database.sqlite.transaction(() => {
        storeCredentials(context.database, context.vault, site.id, updateValues, {
          persistKeys: Object.keys(updateValues),
          expiresAtByKey: accessExpiresAt ? { access_token: accessExpiresAt } : {},
        });
        context.database.db.update(sites).set({
          authStatus: 'authenticated',
          accessExpiresAt,
          updatedAt: new Date().toISOString(),
        }).where(eq(sites.id, site.id)).run();
      })();
    } else {
      context.database.db.update(sites).set({ authStatus: 'interaction_required' })
        .where(eq(sites.id, site.id)).run();
    }
    recordAudit(context.database, request, {
      action: 'site.auth_test', resourceType: 'site', resourceId: site.id,
      metadata: { status: result.status },
    });
    return success(request, {
      status: result.status,
      ...(result.status === 'interaction_required' ? {
        challenge: result.challenge,
        temporary_token: result.temporaryToken,
        masked_identity: result.maskedIdentity,
      } : {}),
    });
  });

  typed.post('/api/v1/sites/:id/auth/challenge', {
    schema: {
      tags: ['sites'],
      summary: '完成站点人工认证挑战',
      params: siteIdParamsSchema,
      body: z.object({
        challenge: z.literal('two_factor'),
        temporary_token: z.string().min(1).max(8_192),
        code: z.string().regex(/^\d{6,8}$/),
      }),
    },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const adapter = context.adapters.get(site.adapterType);
    if (!adapter.completeAuthChallenge) {
      throw new AppError('AUTH_CHALLENGE_UNSUPPORTED', '该适配器不支持在管理端完成认证挑战', 400);
    }
    const outbound = await createSafeFetchContext(site.baseUrl, safeFetchOptions(context));
    try {
      const result = await adapter.completeAuthChallenge({
        siteId: site.id,
        baseUrl: outbound.baseUrl,
        fetch: outbound.fetch,
      }, {
        challenge: request.body.challenge,
        temporaryToken: request.body.temporary_token,
        code: request.body.code,
      });
      if (result.status !== 'authenticated') {
        throw new AppError('AUTH_CHALLENGE_INCOMPLETE', result.message, 400);
      }
      const values = {
        access_token: result.tokens.accessToken,
        ...(result.tokens.refreshToken ? { refresh_token: result.tokens.refreshToken } : {}),
      };
      const accessExpiresAt = result.tokens.expiresAt ?? site.accessExpiresAt;
      context.database.sqlite.transaction(() => {
        storeCredentials(context.database, context.vault, site.id, values, {
          persistKeys: Object.keys(values),
          expiresAtByKey: accessExpiresAt ? { access_token: accessExpiresAt } : {},
        });
        context.database.db.update(sites).set({
          authStatus: 'authenticated',
          accessExpiresAt,
          updatedAt: new Date().toISOString(),
        }).where(eq(sites.id, site.id)).run();
      })();
      recordAudit(context.database, request, {
        action: 'site.auth_challenge', resourceType: 'site', resourceId: site.id,
      });
      return success(request, { status: 'authenticated' });
    } finally {
      await outbound.close();
    }
  });

  typed.post('/api/v1/sites/:id/check/:monitor_type', {
    schema: {
      tags: ['sites'],
      summary: '请求立即执行监控',
      params: siteIdParamsSchema.extend({ monitor_type: monitorTypeSchema }),
    },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const job = context.database.db.select().from(monitorJobs).where(and(
      eq(monitorJobs.siteId, site.id),
      eq(monitorJobs.monitorType, request.params.monitor_type),
    )).get();
    if (!job || job.state === 'disabled') {
      throw new AppError('MONITOR_DISABLED', '该监控当前已关闭', 409);
    }
    const running = job.state === 'running';
    context.database.db.update(monitorJobs).set(running ? {
      runRequested: true,
      updatedAt: new Date().toISOString(),
    } : {
      state: 'queued',
      nextRunAt: new Date().toISOString(),
      attempts: 0,
      updatedAt: new Date().toISOString(),
    }).where(eq(monitorJobs.id, job.id)).run();
    recordAudit(context.database, request, {
      action: 'monitor.check_requested', resourceType: 'site', resourceId: site.id,
      metadata: { monitor_type: request.params.monitor_type, merged: running },
    });
    return success(request, { status: running ? 'run_requested' : 'queued' });
  });

  typed.patch('/api/v1/sites/:id/monitors/:monitor_type', {
    schema: {
      tags: ['sites'],
      summary: '更新独立监控配置',
      params: siteIdParamsSchema.extend({ monitor_type: monitorTypeSchema }),
      body: monitorConfigInputSchema,
    },
  }, async (request) => {
    const site = requireSite(context, request.params.id);
    const monitorType = request.params.monitor_type as MonitorType;
    const configRow = context.database.db.select().from(monitorConfigs).where(and(
      eq(monitorConfigs.siteId, site.id), eq(monitorConfigs.monitorType, monitorType),
    )).get();
    if (!configRow) throw new AppError('MONITOR_NOT_FOUND', '监控配置不存在', 404);
    const jobRow = context.database.db.select().from(monitorJobs).where(and(
      eq(monitorJobs.siteId, site.id), eq(monitorJobs.monitorType, monitorType),
    )).get();
    if (!jobRow) throw new AppError('MONITOR_JOB_NOT_FOUND', '监控任务不存在', 404);
    const now = new Date().toISOString();
    context.database.sqlite.transaction(() => {
      context.database.db.update(monitorConfigs).set({
        enabled: request.body.enabled,
        intervalSeconds: request.body.interval_seconds,
        timeoutSeconds: request.body.timeout_seconds,
        retryCount: request.body.retry_count,
        retryIntervalSeconds: request.body.retry_interval_seconds,
        scheduleJitterPercent: request.body.schedule_jitter_percent,
        updatedAt: now,
      }).where(eq(monitorConfigs.id, configRow.id)).run();
      context.database.db.update(monitorJobs).set(jobRow.state === 'running' ? {
        runRequested: request.body.enabled,
        updatedAt: now,
      } : {
        state: request.body.enabled ? 'queued' : 'disabled',
        nextRunAt: now,
        leaseOwner: null,
        leaseUntil: null,
        attempts: 0,
        retryAfter: null,
        runRequested: false,
        updatedAt: now,
      }).where(eq(monitorJobs.id, jobRow.id)).run();
    })();
    recordAudit(context.database, request, {
      action: request.body.enabled ? 'monitor.enable' : 'monitor.disable',
      resourceType: 'site', resourceId: site.id, metadata: {
        monitor_type: monitorType,
        retry_count: request.body.retry_count,
        retry_interval_seconds: request.body.retry_interval_seconds,
      },
    });
    return success(request, {
      monitor_type: monitorType,
      ...request.body,
      baseline_preserved: true,
    });
  });
}
