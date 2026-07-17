import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type {
  AuthUpdate,
  ProbeApiKey,
  RelayAdapter,
} from '../adapters/index.js';
import type { AppContext } from '../context.js';
import {
  rateProbeConfigs,
  ratesCurrent,
  siteProbeKeyMappings,
  sites,
  type Site,
} from '../db/index.js';
import { AppError } from '../core/errors.js';
import { createId } from '../core/ids.js';
import { createSafeFetchContext } from '../core/safe-fetch.js';
import {
  loadCredentialValue,
  storeCredentials,
} from './credentials.js';
import { rateGroupId } from './rate-scope.js';

const USER_API_TIMEOUT_MS = 15_000;

export interface ProbeKeyMappingInput {
  groupId: string;
  mode: 'existing' | 'auto_create';
  upstreamKeyId?: string;
  quotaLimit?: number;
  expiresInSeconds?: number;
}

export interface ResolvedProbeKeyMapping {
  groupId: string;
  mode: 'existing' | 'auto_create';
  key: ProbeApiKey;
  quotaLimit: number | null;
  expiresInSeconds: number | null;
}

function safeFetchOptions(context: AppContext) {
  return {
    allowHttp: !context.config.isProduction,
    allowedCidrs: context.config.outboundAllowedCidrs,
  };
}

function persistAuthUpdate(context: AppContext, siteId: string, update: AuthUpdate): void {
  const values = {
    access_token: update.accessToken,
    ...(update.refreshToken ? { refresh_token: update.refreshToken } : {}),
  };
  storeCredentials(context.database, context.vault, siteId, values, {
    persistKeys: Object.keys(values),
    expiresAtByKey: update.expiresAt ? { access_token: update.expiresAt } : {},
  });
}

export async function withUserAdapter<T>(
  context: AppContext,
  input: {
    adapter: RelayAdapter;
    siteId: string;
    baseUrl: string;
    credentials: Record<string, string | undefined>;
    persistAuthUpdates?: boolean;
  },
  operation: (adapter: RelayAdapter, siteContext: {
    siteId: string;
    baseUrl: string;
    credentials: Readonly<Record<string, string | undefined>>;
    fetch: typeof globalThis.fetch;
    timeoutMs: number;
    onAuthUpdate: (update: AuthUpdate) => void;
  }) => Promise<T>,
): Promise<T> {
  const outbound = await createSafeFetchContext(input.baseUrl, safeFetchOptions(context));
  try {
    return await operation(input.adapter, {
      siteId: input.siteId,
      baseUrl: outbound.baseUrl,
      credentials: input.credentials,
      fetch: outbound.fetch,
      timeoutMs: USER_API_TIMEOUT_MS,
      onAuthUpdate: (update) => {
        input.credentials.access_token = update.accessToken;
        if (update.refreshToken) input.credentials.refresh_token = update.refreshToken;
        if (update.expiresAt) input.credentials.access_expires_at = update.expiresAt;
        if (input.persistAuthUpdates) persistAuthUpdate(context, input.siteId, update);
      },
    });
  } finally {
    await outbound.close();
  }
}

function requireKeyMethods(adapter: RelayAdapter): void {
  if (!adapter.listProbeApiKeys || !adapter.createProbeApiKey) {
    throw new AppError('UPSTREAM_KEY_MANAGEMENT_UNSUPPORTED', '该站点适配器不支持用户 API Key 管理', 409);
  }
}

function requireUsableProbeKey(key: ProbeApiKey, groupId: string): void {
  if (key.groupId !== groupId) {
    throw new AppError('UPSTREAM_API_KEY_GROUP_MISMATCH', '所选上游 API Key 不属于该分组', 409);
  }
  if (key.status !== 'active') {
    throw new AppError('UPSTREAM_API_KEY_INACTIVE', '所选上游 API Key 当前不可用', 409);
  }
  if (key.expiresAt) {
    const expiresAt = Date.parse(key.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new AppError('UPSTREAM_API_KEY_EXPIRED', '所选上游 API Key 已过期', 409);
    }
  }
  if (!key.secretKey.trim()) {
    throw new AppError('UPSTREAM_API_KEY_SECRET_MISSING', '上游未返回可绑定的 API Key', 409);
  }
}

export function maskedProbeApiKey(key: ProbeApiKey) {
  return {
    id: key.id,
    name: key.name,
    group_id: key.groupId,
    group_name: key.groupName,
    status: key.status,
    expires_at: key.expiresAt,
    quota: key.quota,
    quota_used: key.quotaUsed,
  };
}

export async function listUpstreamProbeApiKeys(
  context: AppContext,
  input: {
    adapter: RelayAdapter;
    siteId: string;
    baseUrl: string;
    credentials: Record<string, string | undefined>;
    persistAuthUpdates?: boolean;
  },
): Promise<readonly ProbeApiKey[]> {
  requireKeyMethods(input.adapter);
  return withUserAdapter(context, input, (adapter, siteContext) => adapter.listProbeApiKeys!(siteContext));
}

export async function resolveProbeKeyMappings(
  context: AppContext,
  input: {
    adapter: RelayAdapter;
    siteId: string;
    baseUrl: string;
    credentials: Record<string, string | undefined>;
    mappings: readonly ProbeKeyMappingInput[];
    persistAuthUpdates?: boolean;
    idempotencyKey?: string;
  },
): Promise<ResolvedProbeKeyMapping[]> {
  if (input.mappings.length === 0) return [];
  requireKeyMethods(input.adapter);
  return withUserAdapter(context, input, async (adapter, siteContext) => {
    let existing: readonly ProbeApiKey[] | undefined;
    const resolved: ResolvedProbeKeyMapping[] = [];
    for (const mapping of input.mappings) {
      if (mapping.mode === 'existing') {
        existing ??= await adapter.listProbeApiKeys!(siteContext);
        const selected = existing.find((key) => key.id === mapping.upstreamKeyId);
        if (!selected) throw new AppError('UPSTREAM_API_KEY_NOT_FOUND', '所选上游 API Key 不存在', 404);
        if (selected.groupId !== mapping.groupId) {
          throw new AppError('UPSTREAM_API_KEY_GROUP_MISMATCH', '所选上游 API Key 不属于该分组', 409);
        }
        requireUsableProbeKey(selected, mapping.groupId);
        resolved.push({
          groupId: mapping.groupId,
          mode: mapping.mode,
          key: selected,
          quotaLimit: null,
          expiresInSeconds: null,
        });
        continue;
      }
      const quota = mapping.quotaLimit;
      const expiresInSeconds = mapping.expiresInSeconds;
      if (quota !== undefined && (!Number.isFinite(quota) || quota <= 0 || quota > 10)) {
        throw new AppError('PROBE_KEY_QUOTA_INVALID', '自动创建 Key 的额度必须大于 0 且不超过 10 USD', 400);
      }
      if (expiresInSeconds !== undefined
        && (!Number.isInteger(expiresInSeconds)
          || expiresInSeconds < 86_400
          || expiresInSeconds > 30 * 86_400)) {
        throw new AppError('PROBE_KEY_EXPIRY_INVALID', '自动创建 Key 的有效期必须在 1 到 30 天之间', 400);
      }
      const created = await adapter.createProbeApiKey!(siteContext, {
        name: `Relay Monitor ${input.siteId} group ${mapping.groupId}`,
        groupId: mapping.groupId,
        ...(quota === undefined ? {} : { quota }),
        ...(expiresInSeconds === undefined
          ? {}
          : { expiresInDays: Math.ceil(expiresInSeconds / 86_400) }),
        idempotencyKey: `relay-monitor-${createHash('sha256').update(JSON.stringify({
          operation: input.idempotencyKey ?? input.siteId,
          groupId: mapping.groupId,
          quota: quota ?? null,
          expiresInSeconds: expiresInSeconds ?? null,
        })).digest('hex')}`,
      });
      requireUsableProbeKey(created, mapping.groupId);
      resolved.push({
        groupId: mapping.groupId,
        mode: mapping.mode,
        key: created,
        quotaLimit: quota ?? null,
        expiresInSeconds: expiresInSeconds ?? null,
      });
    }
    return resolved;
  });
}

function groupCredentialType(groupId: string): string {
  return `site_probe_group:${groupId}:api_key`;
}

function rateCredentialType(rateId: string): string {
  return `rate_probe:${rateId}:api_key`;
}

export function bindProbeKeyToRate(
  context: AppContext,
  input: {
    rateId: string;
    siteId: string;
    key: ProbeApiKey;
    mode: 'existing' | 'auto_create';
    quotaLimit?: number | null;
    expiresInSeconds?: number | null;
  },
): void {
  const credentialType = rateCredentialType(input.rateId);
  const write = () => {
    const existing = context.database.db.select().from(rateProbeConfigs)
      .where(eq(rateProbeConfigs.rateId, input.rateId)).get();
    storeCredentials(context.database, context.vault, input.siteId, {
      [credentialType]: input.key.secretKey,
    }, { persistKeys: [credentialType] });
    const values = {
      useSiteApiKey: false,
      keyMode: 'bound' as const,
      customCredentialType: credentialType,
      upstreamKeyId: input.key.id,
      upstreamKeyManaged: input.mode === 'auto_create',
      autoCreateQuotaLimit: input.quotaLimit === null || input.quotaLimit === undefined
        ? null
        : String(input.quotaLimit),
      autoCreateExpiresInSeconds: input.expiresInSeconds ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (existing) {
      context.database.db.update(rateProbeConfigs).set(values)
        .where(eq(rateProbeConfigs.id, existing.id)).run();
    } else {
      context.database.db.insert(rateProbeConfigs).values({
        id: createId('probeconfig'),
        rateId: input.rateId,
        siteId: input.siteId,
        ...values,
      }).run();
    }
  };
  if (context.database.sqlite.inTransaction) write();
  else context.database.sqlite.transaction(write).immediate();
}

export function persistResolvedProbeKeyMappings(
  context: AppContext,
  siteId: string,
  mappings: readonly ResolvedProbeKeyMapping[],
): void {
  for (const mapping of mappings) {
    const credentialType = groupCredentialType(mapping.groupId);
    storeCredentials(context.database, context.vault, siteId, {
      [credentialType]: mapping.key.secretKey,
    }, { persistKeys: [credentialType] });
    context.database.db.insert(siteProbeKeyMappings).values({
      id: createId('probemap'),
      siteId,
      groupId: mapping.groupId,
      keyMode: mapping.mode,
      upstreamKeyId: mapping.key.id,
      upstreamKeyManaged: mapping.mode === 'auto_create',
      credentialType,
      quotaLimit: mapping.quotaLimit === null ? null : String(mapping.quotaLimit),
      expiresInSeconds: mapping.expiresInSeconds,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [siteProbeKeyMappings.siteId, siteProbeKeyMappings.groupId],
      set: {
        keyMode: mapping.mode,
        upstreamKeyId: mapping.key.id,
        upstreamKeyManaged: mapping.mode === 'auto_create',
        credentialType,
        quotaLimit: mapping.quotaLimit === null ? null : String(mapping.quotaLimit),
        expiresInSeconds: mapping.expiresInSeconds,
        updatedAt: new Date().toISOString(),
      },
    }).run();
    const currentRates = context.database.db.select().from(ratesCurrent)
      .where(eq(ratesCurrent.siteId, siteId)).all();
    for (const rate of currentRates) {
      if (rateGroupId(rate.attributesJson) !== mapping.groupId) continue;
      bindProbeKeyToRate(context, {
        rateId: rate.id,
        siteId,
        key: mapping.key,
        mode: mapping.mode,
        quotaLimit: mapping.quotaLimit,
        expiresInSeconds: mapping.expiresInSeconds,
      });
    }
  }
}

export function bindPendingProbeKeyMapping(
  context: AppContext,
  rate: typeof ratesCurrent.$inferSelect,
): void {
  const groupId = rateGroupId(rate.attributesJson);
  if (!groupId) return;
  const mapping = context.database.db.select().from(siteProbeKeyMappings).where(and(
    eq(siteProbeKeyMappings.siteId, rate.siteId),
    eq(siteProbeKeyMappings.groupId, groupId),
  )).get();
  if (!mapping) return;
  const secretKey = loadCredentialValue(
    context.database,
    context.vault,
    rate.siteId,
    mapping.credentialType,
  );
  if (!secretKey) return;
  bindProbeKeyToRate(context, {
    rateId: rate.id,
    siteId: rate.siteId,
    key: {
      id: mapping.upstreamKeyId ?? '',
      name: 'Relay Monitor probe key',
      groupId,
      groupName: rate.groupName,
      status: 'active',
      expiresAt: null,
      quota: mapping.quotaLimit,
      quotaUsed: null,
      secretKey,
    },
    mode: mapping.keyMode as 'existing' | 'auto_create',
    quotaLimit: mapping.quotaLimit === null ? null : Number(mapping.quotaLimit),
    expiresInSeconds: mapping.expiresInSeconds,
  });
}

export function savedSiteCredentials(context: AppContext, site: Site): Record<string, string | undefined> {
  const keys = ['access_token', 'refresh_token', 'email', 'password', 'auto_reauthenticate'];
  return {
    ...Object.fromEntries(keys.map((key) => [
    key,
    loadCredentialValue(context.database, context.vault, site.id, key),
    ])),
    access_expires_at: site.accessExpiresAt ?? undefined,
  };
}

export async function revokeManagedProbeKeyIds(
  context: AppContext,
  site: Site,
  upstreamKeyIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(upstreamKeyIds.filter(Boolean))];
  if (ids.length === 0) return;
  const adapter = context.adapters.get(site.adapterType);
  if (!adapter.deleteProbeApiKey) {
    throw new AppError(
      'UPSTREAM_KEY_MANAGEMENT_UNSUPPORTED',
      '该站点适配器无法撤销自动创建的上游 API Key',
      409,
    );
  }
  await withUserAdapter(context, {
    adapter,
    siteId: site.id,
    baseUrl: site.baseUrl,
    credentials: savedSiteCredentials(context, site),
    persistAuthUpdates: true,
  }, async (current, siteContext) => {
    for (const id of ids) await current.deleteProbeApiKey!(siteContext, id);
  });
}

export async function revokeManagedProbeKeysForRate(
  context: AppContext,
  rateId: string,
): Promise<void> {
  const rate = context.database.db.select().from(ratesCurrent)
    .where(eq(ratesCurrent.id, rateId)).get();
  if (!rate) return;
  const site = context.database.db.select().from(sites)
    .where(eq(sites.id, rate.siteId)).get();
  if (!site) return;
  const config = context.database.db.select().from(rateProbeConfigs)
    .where(eq(rateProbeConfigs.rateId, rateId)).get();
  const groupId = rateGroupId(rate.attributesJson);
  const mapping = groupId
    ? context.database.db.select().from(siteProbeKeyMappings).where(and(
      eq(siteProbeKeyMappings.siteId, site.id),
      eq(siteProbeKeyMappings.groupId, groupId),
    )).get()
    : undefined;
  await revokeManagedProbeKeyIds(context, site, [
    ...(config?.upstreamKeyManaged && config.upstreamKeyId ? [config.upstreamKeyId] : []),
    ...(mapping?.upstreamKeyManaged && mapping.upstreamKeyId ? [mapping.upstreamKeyId] : []),
  ]);
}

export async function revokeManagedProbeKeysForSite(
  context: AppContext,
  site: Site,
): Promise<void> {
  const configs = context.database.db.select().from(rateProbeConfigs)
    .where(eq(rateProbeConfigs.siteId, site.id)).all();
  const mappings = context.database.db.select().from(siteProbeKeyMappings)
    .where(eq(siteProbeKeyMappings.siteId, site.id)).all();
  await revokeManagedProbeKeyIds(context, site, [
    ...configs.filter((item) => item.upstreamKeyManaged).flatMap((item) => item.upstreamKeyId ? [item.upstreamKeyId] : []),
    ...mappings.filter((item) => item.upstreamKeyManaged).flatMap((item) => item.upstreamKeyId ? [item.upstreamKeyId] : []),
  ]);
}

export async function revokeManagedProbeKeysForGroups(
  context: AppContext,
  site: Site,
  groupIds: readonly string[],
): Promise<void> {
  const groups = new Set(groupIds);
  if (groups.size === 0) return;
  const mappings = context.database.db.select().from(siteProbeKeyMappings)
    .where(eq(siteProbeKeyMappings.siteId, site.id)).all();
  const rates = context.database.db.select().from(ratesCurrent)
    .where(eq(ratesCurrent.siteId, site.id)).all();
  const rateIds = new Set(rates
    .filter((rate) => {
      const groupId = rateGroupId(rate.attributesJson);
      return groupId !== null && groups.has(groupId);
    })
    .map((rate) => rate.id));
  const configs = context.database.db.select().from(rateProbeConfigs)
    .where(eq(rateProbeConfigs.siteId, site.id)).all();
  await revokeManagedProbeKeyIds(context, site, [
    ...mappings
      .filter((mapping) => groups.has(mapping.groupId) && mapping.upstreamKeyManaged)
      .flatMap((mapping) => mapping.upstreamKeyId ? [mapping.upstreamKeyId] : []),
    ...configs
      .filter((config) => rateIds.has(config.rateId) && config.upstreamKeyManaged)
      .flatMap((config) => config.upstreamKeyId ? [config.upstreamKeyId] : []),
  ]);
}
