import { AdapterError, adapterErrorPublicMessage, isAdapterError } from '../contracts/errors.js';
import type {
  HealthResult,
  NormalizedBalance,
  NormalizedRate,
  NormalizedRateSnapshot,
  RateSourceStatus,
  SiteContext,
} from '../contracts/types.js';
import { createSub2ApiClient, requestWithSub2ApiAuth } from './auth.js';
import { rateSnapshotFingerprint } from '../../core/rate-snapshots.js';
import {
  channelsSchema,
  groupsSchema,
  modelsResponseSchema,
  userGroupRatesSchema,
  userProfileSchema,
  type GroupResponse,
} from './schemas.js';

function checkedAt(ctx: SiteContext): string {
  return (ctx.now ?? new Date()).toISOString();
}

function healthStatusForError(error: AdapterError): HealthResult['status'] {
  if (error.code === 'UPSTREAM_UNREACHABLE' || error.code === 'UPSTREAM_SERVER_ERROR') return 'down';
  return 'degraded';
}

function publicErrorMessage(error: AdapterError): string {
  return adapterErrorPublicMessage(error);
}

export async function collectSub2ApiConnectivity(ctx: SiteContext): Promise<HealthResult> {
  const startedAt = performance.now();
  const at = checkedAt(ctx);
  const apiKey = ctx.credentials?.api_key;
  try {
    if (apiKey) {
      const response = await createSub2ApiClient(ctx).request<Array<{ id: string }>>('/v1/models', {
        bearerToken: apiKey,
        schema: modelsResponseSchema,
        unwrapEnvelope: false,
        authFailureCode: 'AUTH_ACCESS_EXPIRED',
      });
      return {
        status: 'healthy',
        probeKind: 'model_api',
        authenticated: true,
        latencyMs: response.latencyMs,
        checkedAt: at,
        httpStatus: response.httpStatus,
        modelCount: response.data.length,
      };
    }

    const response = await requestWithSub2ApiAuth(ctx, (client, accessToken) =>
      client.request('/api/v1/auth/me', {
        bearerToken: accessToken,
        schema: userProfileSchema,
        authFailureCode: 'AUTH_ACCESS_EXPIRED',
      }),
    );
    return {
      status: 'healthy',
      probeKind: 'user_api',
      authenticated: true,
      latencyMs: response.latencyMs,
      checkedAt: at,
      httpStatus: response.httpStatus,
      ...(response.authUpdate ? { authUpdate: response.authUpdate } : {}),
    };
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    return {
      status: healthStatusForError(error),
      probeKind: apiKey ? 'model_api' : 'user_api',
      authenticated: [
        'AUTH_ACCESS_EXPIRED',
        'AUTH_REFRESH_FAILED',
        'AUTH_INVALID_CREDENTIALS',
      ].includes(error.code)
        ? false
        : null,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      checkedAt: at,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      errorCode: error.code,
      errorMessage: publicErrorMessage(error),
      ...(error.retryable ? { retryable: true } : {}),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
}

export async function collectSub2ApiBalances(ctx: SiteContext): Promise<NormalizedBalance[]> {
  const response = await requestWithSub2ApiAuth(ctx, (client, accessToken) =>
    client.request('/api/v1/auth/me', {
      bearerToken: accessToken,
      schema: userProfileSchema,
      authFailureCode: 'AUTH_ACCESS_EXPIRED',
    }),
  );
  const profile = response.data;
  return [
    {
      balanceKey: 'cash:balance',
      balanceKind: 'cash',
      value: profile.balance,
      available: profile.balance,
      unit: 'USD',
      ...(profile.frozen_balance !== undefined && profile.frozen_balance !== null
        ? { frozen: profile.frozen_balance }
        : {}),
      collectedAt: checkedAt(ctx),
      attributes: {
        upstream_field: 'balance',
        ...(profile.total_recharged !== undefined && profile.total_recharged !== null
          ? { total_recharged: profile.total_recharged }
          : {}),
      },
    },
  ];
}

interface SourceAttempt<T> {
  source: RateSourceStatus;
  data?: T;
  authUpdate?: { accessToken: string; refreshToken?: string; expiresAt?: string };
}

async function attempt<T>(
  source: string,
  required: boolean,
  operation: () => Promise<{ data: T; authUpdate?: SourceAttempt<T>['authUpdate'] }>,
): Promise<SourceAttempt<T>> {
  try {
    const result = await operation();
    return {
      source: { source, required, status: 'success' },
      data: result.data,
      ...(result.authUpdate ? { authUpdate: result.authUpdate } : {}),
    };
  } catch (error) {
    if (!isAdapterError(error)) throw error;
    const unsupported = isAdapterError(error, 'UPSTREAM_CAPABILITY_UNSUPPORTED');
    const incompatible = isAdapterError(error, 'UPSTREAM_SCHEMA_ERROR');
    return {
      source: {
        source,
        required,
        status: unsupported ? 'unsupported' : incompatible ? 'incompatible' : 'failed',
        errorCode: error.code,
        ...(error.retryable ? { retryable: true } : {}),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      },
    };
  }
}

function contextWithAuthUpdate(ctx: SiteContext, update: SourceAttempt<unknown>['authUpdate']): SiteContext {
  if (!update) return ctx;
  return {
    ...ctx,
    credentials: {
      ...ctx.credentials,
      access_token: update.accessToken,
      ...(update.refreshToken ? { refresh_token: update.refreshToken } : {}),
      ...(update.expiresAt ? { access_expires_at: update.expiresAt } : {}),
    },
  };
}

function rateAttributes(group: GroupResponse, userRate: string | undefined, effectiveRate: string) {
  return {
    group_id: group.id,
    base_rate: group.rate_multiplier,
    user_rate: userRate ?? null,
    effective_rate: effectiveRate,
    peak_enabled: group.peak_rate_enabled ?? false,
    peak_rate: group.peak_rate_multiplier ?? null,
    peak_start: group.peak_start ?? null,
    peak_end: group.peak_end ?? null,
    subscription_type: group.subscription_type ?? null,
  } as const;
}

function normalizeGroupRate(
  group: GroupResponse,
  userRate: string | undefined,
  collectedAt: string,
  dataQuality: NormalizedRate['dataQuality'],
): NormalizedRate {
  const effectiveRate = userRate ?? group.rate_multiplier;
  return {
    rateKey: `group:${group.id}:effective`,
    rateKind: 'group',
    name: group.name,
    platform: group.platform,
    group: group.name,
    value: effectiveRate,
    unit: 'multiplier',
    comparisonKey: `sub2api:group:${group.platform}:effective:v1`,
    billingExpression: 'effective_rate = user_rate ?? base_rate; peak is stored separately',
    metadataStatus: 'available',
    probeStatus: 'not_configured',
    collectedAt,
    dataQuality,
    matchConfidence: 'high',
    attributes: rateAttributes(group, userRate, effectiveRate),
  };
}

function selectedGroups(ctx: SiteContext): { selected: Set<string> | null; excluded: Set<string> } {
  const scope = ctx.adapterMetadata?.rate_group_scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return { selected: null, excluded: new Set() };
  }
  const value = scope as Record<string, unknown>;
  const selected = value.mode === 'selected' && Array.isArray(value.groupIds)
    ? new Set(value.groupIds.filter((id): id is string => typeof id === 'string'))
    : null;
  const excluded = Array.isArray(value.excluded_group_ids)
    ? new Set(value.excluded_group_ids.filter((id): id is string => typeof id === 'string'))
    : new Set<string>();
  return { selected, excluded };
}

export async function collectSub2ApiRates(ctx: SiteContext): Promise<NormalizedRateSnapshot> {
  const collectedAt = checkedAt(ctx);
  const groups = await attempt('groups.available', true, () =>
    requestWithSub2ApiAuth(ctx, (client, accessToken) =>
      client.request('/api/v1/groups/available', {
        bearerToken: accessToken,
        schema: groupsSchema,
        authFailureCode: 'AUTH_ACCESS_EXPIRED',
      }),
    ),
  );
  const refreshedContext = contextWithAuthUpdate(ctx, groups.authUpdate);
  const userRates = await attempt('groups.rates', true, () =>
    requestWithSub2ApiAuth(refreshedContext, (client, accessToken) =>
      client.request('/api/v1/groups/rates', {
        bearerToken: accessToken,
        schema: userGroupRatesSchema,
        authFailureCode: 'AUTH_ACCESS_EXPIRED',
      }),
    ),
  );
  const latestContext = contextWithAuthUpdate(refreshedContext, userRates.authUpdate);
  const channels = await attempt('channels.available', false, () =>
    requestWithSub2ApiAuth(latestContext, (client, accessToken) =>
      client.request('/api/v1/channels/available', {
        bearerToken: accessToken,
        schema: channelsSchema,
        optionalCapability: true,
        authFailureCode: 'AUTH_ACCESS_EXPIRED',
      }),
    ),
  );

  const sources = [groups.source, userRates.source, channels.source];
  const requiredFailed = sources.some(
    (source) => source.required && source.status !== 'success' && source.status !== 'unsupported',
  );
  const quality: NormalizedRateSnapshot['quality'] = requiredFailed ? 'partial' : 'complete';
  const rateQuality: NormalizedRate['dataQuality'] = quality === 'complete' ? 'complete' : 'partial';
  const userRateMap = userRates.data ?? {};
  const scope = selectedGroups(ctx);
  const rates = (groups.data ?? [])
    .filter((group) => (scope.selected === null || scope.selected.has(group.id)) && !scope.excluded.has(group.id))
    .map((group) =>
    normalizeGroupRate(group, userRateMap[group.id], collectedAt, rateQuality),
  );
  const update = channels.authUpdate ?? userRates.authUpdate ?? groups.authUpdate;

  const snapshot: NormalizedRateSnapshot = {
    quality,
    collectedAt,
    rates,
    sources,
    ...(update ? { authUpdate: update } : {}),
  };
  return { ...snapshot, fingerprint: rateSnapshotFingerprint(snapshot) };
}

export function rateCollectionErrorCode(snapshot: NormalizedRateSnapshot): string | undefined {
  return snapshot.sources.find((source) => source.status === 'failed' || source.status === 'incompatible')
    ?.errorCode;
}

export function ensureCompleteRateSnapshot(snapshot: NormalizedRateSnapshot): void {
  if (snapshot.quality !== 'complete') {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'Rate snapshot is not complete', {
      details: { sourceErrorCode: rateCollectionErrorCode(snapshot) },
    });
  }
}
