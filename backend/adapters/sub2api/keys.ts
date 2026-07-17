import { AdapterError } from '../contracts/errors.js';
import { z } from 'zod';
import type {
  CreateProbeApiKeyRequest,
  ProbeApiKey,
  SiteContext,
} from '../contracts/types.js';
import { requestWithSub2ApiAuth } from './auth.js';
import { apiKeyListSchema, apiKeySchema, type ApiKeyResponse } from './schemas.js';

function groupIdNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', 'The upstream group ID cannot be represented safely');
  }
  return parsed;
}

function normalizedKey(value: ApiKeyResponse): ProbeApiKey {
  return {
    id: value.id,
    name: value.name,
    groupId: value.group_id ?? null,
    groupName: value.group?.name ?? null,
    status: value.status,
    expiresAt: value.expires_at ?? null,
    quota: value.quota ?? null,
    quotaUsed: value.quota_used ?? null,
    secretKey: value.key,
  };
}

export async function listSub2ApiProbeApiKeys(ctx: SiteContext): Promise<readonly ProbeApiKey[]> {
  const response = await requestWithSub2ApiAuth(ctx, (client, accessToken) =>
    client.request('/api/v1/keys?page=1&page_size=1000', {
      bearerToken: accessToken,
      schema: apiKeyListSchema,
      authFailureCode: 'AUTH_ACCESS_EXPIRED',
    }),
  );
  return response.data.items.map(normalizedKey);
}

export async function createSub2ApiProbeApiKey(
  ctx: SiteContext,
  input: CreateProbeApiKeyRequest,
): Promise<ProbeApiKey> {
  const response = await requestWithSub2ApiAuth(ctx, (client, accessToken) =>
    client.request('/api/v1/keys', {
      method: 'POST',
      bearerToken: accessToken,
      body: {
        name: input.name,
        group_id: groupIdNumber(input.groupId),
        ...(input.quota === undefined ? {} : { quota: input.quota }),
        ...(input.expiresInDays === undefined ? {} : { expires_in_days: input.expiresInDays }),
        ip_whitelist: [],
        ip_blacklist: [],
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      schema: apiKeySchema,
      authFailureCode: 'AUTH_ACCESS_EXPIRED',
    }),
  );
  return normalizedKey(response.data);
}

export async function deleteSub2ApiProbeApiKey(
  ctx: SiteContext,
  upstreamKeyId: string,
): Promise<void> {
  try {
    await requestWithSub2ApiAuth(ctx, (client, accessToken) =>
      client.request(`/api/v1/keys/${encodeURIComponent(upstreamKeyId)}`, {
        method: 'DELETE',
        bearerToken: accessToken,
        schema: z.unknown(),
        authFailureCode: 'AUTH_ACCESS_EXPIRED',
      }),
    );
  } catch (error) {
    if (error instanceof AdapterError && error.httpStatus === 404) return;
    throw error;
  }
}
