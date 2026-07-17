import { createHash } from 'node:crypto';

import { AdapterError, isAdapterError } from '../contracts/errors.js';
import type {
  AuthResult,
  AuthChallengeInput,
  Capability,
  CapabilitySet,
  CredentialInput,
  RelayAdapter,
  SiteContext,
} from '../contracts/types.js';
import {
  authenticateSub2Api,
  completeSub2ApiTwoFactor,
  createSub2ApiClient,
  refreshOrReauthenticateSub2Api,
} from './auth.js';
import {
  collectSub2ApiBalances,
  collectSub2ApiConnectivity,
  collectSub2ApiRates,
} from './collectors.js';
import { listSub2ApiProbeModels, probeSub2ApiModel } from './probe.js';
import { sub2ApiCredentialSchema, sub2ApiManifest } from './manifest.js';
import {
  createSub2ApiProbeApiKey,
  deleteSub2ApiProbeApiKey,
  listSub2ApiProbeApiKeys,
} from './keys.js';
import { channelsSchema, groupsSchema, userGroupRatesSchema, userProfileSchema } from './schemas.js';

function capability(status: Capability['status'], checkedAt: string, errorCode?: string): Capability {
  return {
    status,
    checkedAt,
    ...(errorCode ? { lastErrorCode: errorCode } : {}),
  };
}

function capabilityFromError(error: unknown, checkedAt: string): Capability {
  if (!isAdapterError(error)) return capability('unknown', checkedAt);
  if (error.code === 'UPSTREAM_CAPABILITY_UNSUPPORTED') {
    return capability('unsupported', checkedAt, error.code);
  }
  if (error.code === 'UPSTREAM_SCHEMA_ERROR') {
    return capability('incompatible', checkedAt, error.code);
  }
  return capability('unknown', checkedAt, error.code);
}

export class Sub2ApiAdapter implements RelayAdapter {
  readonly credentialSchema = sub2ApiCredentialSchema;

  manifest() {
    return sub2ApiManifest();
  }

  async discover(ctx: SiteContext): Promise<CapabilitySet> {
    const detectedAt = (ctx.now ?? new Date()).toISOString();
    const accessToken = ctx.credentials?.access_token;
    const fingerprints: string[] = [];
    const capabilities: Record<string, Capability> = {
      auth: capability('supported', detectedAt),
      auth_refresh: capability('supported', detectedAt),
      active_probe: capability(ctx.credentials?.api_key ? 'supported' : 'unknown', detectedAt),
      balance: capability('unknown', detectedAt),
      rates: capability('unknown', detectedAt),
      user_rates: capability('unknown', detectedAt),
      channels: capability('unknown', detectedAt),
      requires_2fa: capability('unknown', detectedAt),
      requires_turnstile: capability('unknown', detectedAt),
    };

    if (accessToken) {
      const client = createSub2ApiClient(ctx);
      try {
        const profile = await client.request('/api/v1/auth/me', {
          bearerToken: accessToken,
          schema: userProfileSchema,
          authFailureCode: 'AUTH_ACCESS_EXPIRED',
        });
        fingerprints.push(profile.structureFingerprint);
        capabilities.balance = capability('supported', detectedAt);
      } catch (error) {
        capabilities.balance = capabilityFromError(error, detectedAt);
      }

      try {
        const groups = await client.request('/api/v1/groups/available', {
          bearerToken: accessToken,
          schema: groupsSchema,
          authFailureCode: 'AUTH_ACCESS_EXPIRED',
        });
        fingerprints.push(groups.structureFingerprint);
        capabilities.rates = capability('supported', detectedAt);
      } catch (error) {
        capabilities.rates = capabilityFromError(error, detectedAt);
      }

      try {
        const rates = await client.request('/api/v1/groups/rates', {
          bearerToken: accessToken,
          schema: userGroupRatesSchema,
          authFailureCode: 'AUTH_ACCESS_EXPIRED',
        });
        fingerprints.push(rates.structureFingerprint);
        capabilities.user_rates = capability('supported', detectedAt);
      } catch (error) {
        capabilities.user_rates = capabilityFromError(error, detectedAt);
      }

      try {
        const channels = await client.request('/api/v1/channels/available', {
          bearerToken: accessToken,
          schema: channelsSchema,
          optionalCapability: true,
          authFailureCode: 'AUTH_ACCESS_EXPIRED',
        });
        fingerprints.push(channels.structureFingerprint);
        capabilities.channels = capability('supported', detectedAt);
      } catch (error) {
        capabilities.channels = capabilityFromError(error, detectedAt);
      }
    }

    const responseStructureFingerprint =
      fingerprints.length > 0
        ? createHash('sha256').update([...new Set(fingerprints)].sort().join(':'), 'utf8').digest('hex')
        : undefined;
    return {
      adapterType: 'sub2api',
      adapterVersion: sub2ApiManifest().adapterVersion,
      adapterSchemaVersion: sub2ApiManifest().adapterSchemaVersion,
      detectedAt,
      ...(responseStructureFingerprint ? { responseStructureFingerprint } : {}),
      capabilities,
    };
  }

  authenticate(ctx: SiteContext, input: CredentialInput): Promise<AuthResult> {
    return authenticateSub2Api(ctx, input);
  }

  completeAuthChallenge(ctx: SiteContext, input: AuthChallengeInput): Promise<AuthResult> {
    return completeSub2ApiTwoFactor(ctx, input.temporaryToken, input.code);
  }

  refreshAuth(ctx: SiteContext): Promise<AuthResult> {
    return refreshOrReauthenticateSub2Api(ctx);
  }

  collectConnectivity(ctx: SiteContext) {
    return collectSub2ApiConnectivity(ctx);
  }

  collectBalances(ctx: SiteContext) {
    return collectSub2ApiBalances(ctx);
  }

  collectRates(ctx: SiteContext) {
    return collectSub2ApiRates(ctx);
  }

  listProbeModels(ctx: SiteContext) {
    return listSub2ApiProbeModels(ctx);
  }

  probeModel(ctx: SiteContext, input: Parameters<typeof probeSub2ApiModel>[1]) {
    return probeSub2ApiModel(ctx, input);
  }

  listProbeApiKeys(ctx: SiteContext) {
    return listSub2ApiProbeApiKeys(ctx);
  }

  createProbeApiKey(ctx: SiteContext, input: Parameters<typeof createSub2ApiProbeApiKey>[1]) {
    return createSub2ApiProbeApiKey(ctx, input);
  }

  deleteProbeApiKey(ctx: SiteContext, upstreamKeyId: string) {
    return deleteSub2ApiProbeApiKey(ctx, upstreamKeyId);
  }
}

export function assertSub2ApiAdapter(adapter: RelayAdapter): asserts adapter is Sub2ApiAdapter {
  if (adapter.manifest().adapterType !== 'sub2api') {
    throw new AdapterError('ADAPTER_UNAVAILABLE', 'Expected the Sub2API adapter');
  }
}
