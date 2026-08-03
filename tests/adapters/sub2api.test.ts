import { describe, expect, it, vi } from 'vitest';

import { AdapterError } from '../../backend/adapters/contracts/errors.js';
import type { SiteContext } from '../../backend/adapters/contracts/types.js';
import {
  authenticateSub2Api,
  collectSub2ApiBalances,
  collectSub2ApiConnectivity,
  collectSub2ApiRates,
  completeSub2ApiTwoFactor,
  createSub2ApiProbeApiKey,
  deleteSub2ApiProbeApiKey,
  listSub2ApiProbeApiKeys,
  listSub2ApiProbeModels,
  probeSub2ApiModel,
  refreshOrReauthenticateSub2Api,
  Sub2ApiClient,
  visibleOutputTps,
} from '../../backend/adapters/sub2api/index.js';
import { groupsSchema } from '../../backend/adapters/sub2api/schemas.js';

type FetchHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  ) as unknown as typeof globalThis.fetch;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function rawJson(value: string, status = 200): Response {
  return new Response(value, { status, headers: { 'Content-Type': 'application/json' } });
}

function context(fetch: typeof globalThis.fetch, credentials: SiteContext['credentials'] = {}): SiteContext {
  return {
    siteId: 'site_1',
    baseUrl: 'https://relay.example',
    fetch,
    credentials,
    now: new Date('2026-07-14T00:00:00.000Z'),
  };
}

describe('Sub2API adapter', () => {
  it('parses upstream decimal numbers losslessly before Zod normalization', async () => {
    const fetch = fakeFetch(() =>
      rawJson(
        '{"code":0,"message":"success","data":[{"id":9007199254740993,"name":"Precise","platform":"openai","rate_multiplier":0.123456789012345678901}]}',
      ),
    );
    const response = await new Sub2ApiClient({ baseUrl: 'https://relay.example', fetch }).request(
      '/api/v1/groups/available',
      { schema: groupsSchema, bearerToken: 'access' },
    );
    expect(response.data[0]).toMatchObject({
      id: '9007199254740993',
      rate_multiplier: '0.123456789012345678901',
    });
  });

  it('returns a two-factor challenge without persisting the temporary token', async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.pathname === '/api/v1/settings/public') {
        return json({ code: 0, data: { geetest_enabled: false } });
      }
      expect(url.pathname).toBe('/api/v1/auth/login');
      expect(JSON.parse(String(init.body))).toMatchObject({
        email: 'user@example.com',
        password: 'secret',
        turnstile_token: '',
      });
      return json({
        code: 0,
        message: 'success',
        data: { requires_2fa: true, temp_token: 'temporary', user_email_masked: 'u***@example.com' },
      });
    });
    const result = await authenticateSub2Api(context(fetch), {
      mode: 'password',
      values: { email: 'user@example.com', password: 'secret' },
    });
    expect(result).toEqual({
      status: 'interaction_required',
      challenge: 'two_factor',
      temporaryToken: 'temporary',
      maskedIdentity: 'u***@example.com',
      message: '目标站点要求输入 TOTP 二次验证码。',
    });
  });

  it('requires manual token setup when public settings enable Geetest', async () => {
    const fetch = fakeFetch((url) => {
      expect(url.pathname).toBe('/api/v1/settings/public');
      return json({ code: 0, data: { geetest_enabled: true, turnstile_enabled: false } });
    });
    const result = await authenticateSub2Api(context(fetch), {
      mode: 'password',
      values: { email: 'user@example.com', password: 'secret' },
    });
    expect(result).toEqual({
      status: 'interaction_required',
      challenge: 'other',
      message: '目标站点已启用 Geetest 人机验证，Relay Monitor 不会绕过验证。请先在站点网页登录，再改用 Access Token 添加中转站。',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to password login when an older deployment has no public settings endpoint', async () => {
    const paths: string[] = [];
    const fetch = fakeFetch((url) => {
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/settings/public') {
        return json({ code: 404, message: 'not found' }, 404);
      }
      return json({
        code: 0,
        data: {
          access_token: 'legacy-access',
          token_type: 'Bearer',
        },
      });
    });
    const result = await authenticateSub2Api(context(fetch), {
      mode: 'password',
      values: { email: 'user@example.com', password: 'secret' },
    });
    expect(result).toMatchObject({ status: 'authenticated' });
    expect(paths).toEqual(['/api/v1/settings/public', '/api/v1/auth/login']);
  });

  it('completes human-entered TOTP and computes token expiry', async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/api/v1/auth/login/2fa');
      expect(JSON.parse(String(init.body))).toEqual({ temp_token: 'temporary', totp_code: '123456' });
      return json({
        code: 0,
        data: {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 600,
          token_type: 'Bearer',
          user: { id: 12, email: 'user@example.com' },
        },
      });
    });
    const result = await completeSub2ApiTwoFactor(context(fetch), 'temporary', '123456');
    expect(result).toMatchObject({
      status: 'authenticated',
      tokens: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: '2026-07-14T00:10:00.000Z',
      },
      user: { id: '12', email: 'user@example.com' },
    });
  });

  it('reports Turnstile as manual interaction and never attempts a bypass', async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === '/api/v1/settings/public') {
        return json({ code: 0, data: { geetest_enabled: false } });
      }
      return json({ code: 400, reason: 'TURNSTILE_VERIFICATION_FAILED', message: 'turnstile token required' }, 400);
    });
    const result = await authenticateSub2Api(context(fetch), {
      mode: 'password',
      values: { email: 'user@example.com', password: 'secret' },
    });
    expect(result).toMatchObject({ status: 'interaction_required', challenge: 'turnstile' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('collects strong connectivity with an API key', async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/v1/models');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-monitor');
      return json({ object: 'list', data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] });
    });
    const result = await collectSub2ApiConnectivity(context(fetch, { api_key: 'sk-monitor' }));
    expect(result).toMatchObject({
      status: 'healthy',
      probeKind: 'model_api',
      authenticated: true,
      modelCount: 2,
    });
  });

  it('refreshes once on 401, retries the original request, and exposes rotated tokens', async () => {
    let profileRequests = 0;
    const onAuthUpdate = vi.fn();
    const fetch = fakeFetch((url, init) => {
      if (url.pathname === '/api/v1/auth/refresh') {
        expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'old-refresh' });
        return json({
          code: 0,
          data: {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        });
      }
      profileRequests += 1;
      const authorization = new Headers(init.headers).get('Authorization');
      if (authorization === 'Bearer old-access') return json({ code: 401, message: 'expired' }, 401);
      expect(authorization).toBe('Bearer new-access');
      return json({ code: 0, data: { id: 1, balance: 12.50, frozen_balance: 0 } });
    });
    const ctx: SiteContext = {
      ...context(fetch, { access_token: 'old-access', refresh_token: 'old-refresh' }),
      onAuthUpdate,
    };
    const result = await collectSub2ApiConnectivity(ctx);
    expect(profileRequests).toBe(2);
    expect(result.authUpdate).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: '2026-07-14T01:00:00.000Z',
    });
    expect(onAuthUpdate).toHaveBeenCalledWith(result.authUpdate);
  });

  it('proactively refreshes an access token with less than ten minutes remaining', async () => {
    const paths: string[] = [];
    const fetch = fakeFetch((url, init) => {
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/auth/refresh') {
        return json({
          code: 0,
          data: {
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        });
      }
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fresh-access');
      return json({ code: 0, data: { id: 1, balance: 10 } });
    });
    const result = await collectSub2ApiConnectivity(
      context(fetch, {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        access_expires_at: '2026-07-14T00:09:59.000Z',
      }),
    );
    expect(paths).toEqual(['/api/v1/auth/refresh', '/api/v1/auth/me']);
    expect(result.authUpdate?.accessToken).toBe('fresh-access');
  });

  it('falls back to stored-password login when enabled or when an older UI stored the password without the flag', async () => {
    const paths: string[] = [];
    const fetch = fakeFetch((url) => {
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/auth/refresh') {
        return json({ code: 400, message: 'invalid refresh token' }, 400);
      }
      if (url.pathname === '/api/v1/settings/public') {
        return json({ code: 0, data: { geetest_enabled: false } });
      }
      return json({
        code: 0,
        data: {
          access_token: 'relogin-access',
          refresh_token: 'relogin-refresh',
          token_type: 'Bearer',
        },
      });
    });
    const result = await refreshOrReauthenticateSub2Api(
      context(fetch, {
        refresh_token: 'expired-refresh',
        email: 'user@example.com',
        password: 'stored-password',
        auto_reauthenticate: 'true',
      }),
    );
    expect(paths).toEqual(['/api/v1/auth/refresh', '/api/v1/settings/public', '/api/v1/auth/login']);
    expect(result).toMatchObject({
      status: 'authenticated',
      tokens: { accessToken: 'relogin-access', refreshToken: 'relogin-refresh' },
    });

    const legacyResult = await refreshOrReauthenticateSub2Api(
      context(fetch, {
        refresh_token: 'expired-refresh',
        email: 'user@example.com',
        password: 'stored-password',
      }),
    );
    expect(legacyResult).toMatchObject({
      status: 'authenticated',
      tokens: { accessToken: 'relogin-access', refreshToken: 'relogin-refresh' },
    });

    await expect(
      refreshOrReauthenticateSub2Api(
        context(fetch, {
          refresh_token: 'expired-refresh',
          email: 'user@example.com',
          password: 'stored-password',
          auto_reauthenticate: 'false',
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REFRESH_FAILED' });
  });

  it('normalizes balances as decimal strings', async () => {
    const fetch = fakeFetch(() =>
      rawJson(
        '{"code":0,"data":{"id":1,"balance":9007199254740993.1200,"frozen_balance":0.005,"total_recharged":10000.00}}',
      ),
    );
    const balances = await collectSub2ApiBalances(context(fetch, { access_token: 'access' }));
    expect(balances[0]).toMatchObject({
      balanceKey: 'cash:balance',
      balanceKind: 'cash',
      value: '9007199254740993.12',
      frozen: '0.005',
      unit: 'USD',
      attributes: { total_recharged: '10000' },
    });
  });

  it('keeps Geetest as manual interaction after refresh fallback', async () => {
    const paths: string[] = [];
    const fetch = fakeFetch((url) => {
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/auth/me') {
        return json({ code: 401, message: 'expired' }, 401);
      }
      if (url.pathname === '/api/v1/auth/refresh') {
        return json({ code: 400, message: 'invalid refresh token' }, 400);
      }
      if (url.pathname === '/api/v1/settings/public') {
        return json({ code: 0, data: { geetest_enabled: true } });
      }
      throw new Error(`Unexpected path: ${url.pathname}`);
    });
    const result = await collectSub2ApiConnectivity(context(fetch, {
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
      email: 'user@example.com',
      password: 'stored-password',
      auto_reauthenticate: 'true',
    }));
    expect(result).toMatchObject({
      status: 'degraded',
      errorCode: 'AUTH_INTERACTION_REQUIRED',
      errorMessage: '目标站点要求人工验证，请完成验证后重试。',
    });
    expect(paths).toEqual([
      '/api/v1/auth/me',
      '/api/v1/auth/refresh',
      '/api/v1/settings/public',
    ]);
  });

  it('maps base, user, effective, and peak rates with stable keys', async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === '/api/v1/groups/available') {
        return rawJson(
          '{"code":0,"data":[{"id":12,"name":"GPT Pro","platform":"openai","rate_multiplier":0.120,"peak_rate_enabled":true,"peak_rate_multiplier":1.5,"peak_start":"09:00","peak_end":"18:00"}]}',
        );
      }
      if (url.pathname === '/api/v1/groups/rates') {
        return rawJson('{"code":0,"data":{"12":0.10000000000000000001}}');
      }
      if (url.pathname === '/api/v1/channels/available') {
        return json({ code: 404, message: 'not found' }, 404);
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    const result = await collectSub2ApiRates(context(fetch, { access_token: 'access' }));
    expect(result.quality).toBe('complete');
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sources).toContainEqual({
      source: 'channels.available',
      required: false,
      status: 'unsupported',
      errorCode: 'UPSTREAM_CAPABILITY_UNSUPPORTED',
    });
    expect(result.rates[0]).toMatchObject({
      rateKey: 'group:12:effective',
      rateKind: 'group',
      value: '0.10000000000000000001',
      comparisonKey: 'sub2api:group:openai:effective:v1',
      dataQuality: 'complete',
      attributes: {
        group_id: '12',
        base_rate: '0.12',
        user_rate: '0.10000000000000000001',
        effective_rate: '0.10000000000000000001',
        peak_enabled: true,
        peak_rate: '1.5',
      },
    });
  });

  it('returns a partial snapshot when a required rate endpoint fails', async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === '/api/v1/groups/available') {
        return json({
          code: 0,
          data: [{ id: 12, name: 'GPT Pro', platform: 'openai', rate_multiplier: 0.12 }],
        });
      }
      if (url.pathname === '/api/v1/groups/rates') {
        return json({ code: 500, message: 'temporary failure' }, 500);
      }
      return json({ code: 0, data: [] });
    });
    const result = await collectSub2ApiRates(context(fetch, { access_token: 'access' }));
    expect(result.quality).toBe('partial');
    expect(result.rates[0]).toMatchObject({ value: '0.12', dataQuality: 'partial' });
    expect(result.sources).toContainEqual({
      source: 'groups.rates',
      required: true,
      status: 'failed',
      errorCode: 'UPSTREAM_SERVER_ERROR',
      retryable: true,
    });
  });

  it('preserves Retry-After metadata on a partial rate snapshot', async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === '/api/v1/groups/available') {
        return json({
          code: 0,
          data: [{ id: 12, name: 'GPT Pro', platform: 'openai', rate_multiplier: 0.12 }],
        });
      }
      if (url.pathname === '/api/v1/groups/rates') {
        return new Response(JSON.stringify({ code: 429, message: 'slow down' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '120' },
        });
      }
      return json({ code: 0, data: [] });
    });
    const result = await collectSub2ApiRates(context(fetch, { access_token: 'access' }));
    expect(result.quality).toBe('partial');
    expect(result.sources).toContainEqual({
      source: 'groups.rates',
      required: true,
      status: 'failed',
      errorCode: 'UPSTREAM_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 120_000,
    });
  });

  it('filters persisted rates to the selected group scope and explicit exclusions', async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === '/api/v1/groups/available') {
        return json({
          code: 0,
          data: [
            { id: 11, name: 'Group 11', platform: 'openai', rate_multiplier: 0.11 },
            { id: 12, name: 'Group 12', platform: 'openai', rate_multiplier: 0.12 },
            { id: 13, name: 'Group 13', platform: 'openai', rate_multiplier: 0.13 },
          ],
        });
      }
      if (url.pathname === '/api/v1/groups/rates') {
        return json({ code: 0, data: { 11: 0.21, 12: 0.22, 13: 0.23 } });
      }
      return json({ code: 0, data: [] });
    });
    const ctx = context(fetch, { access_token: 'access' });
    ctx.adapterMetadata = {
      rate_group_scope: {
        mode: 'selected',
        groupIds: ['11', '12'],
        excluded_group_ids: ['12'],
      },
    };
    const result = await collectSub2ApiRates(ctx);
    expect(result.rates.map((rate) => rate.attributes.group_id)).toEqual(['11']);
  });

  it('uses the authenticated user key API and keeps returned secrets internal', async () => {
    const fetch = fakeFetch((url, init) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access');
      if (init.method === 'DELETE') {
        expect(url.pathname).toBe('/api/v1/keys/91');
        return json({ code: 0, data: { message: 'deleted' } });
      }
      if (init.method === 'POST') {
        expect(url.pathname).toBe('/api/v1/keys');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const unlimited = body.name === 'Relay Monitor unlimited group 12';
        expect(body).toEqual(unlimited ? {
          name: 'Relay Monitor unlimited group 12',
          group_id: 12,
          ip_whitelist: [],
          ip_blacklist: [],
        } : {
          name: 'Relay Monitor group 12',
          group_id: 12,
          quota: 1,
          expires_in_days: 3,
          ip_whitelist: [],
          ip_blacklist: [],
        });
        expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
          unlimited ? 'relay-key-create-unlimited' : 'relay-key-create-1',
        );
        return json({
          code: 0,
          data: {
            id: unlimited ? 92 : 91,
            key: 'sk-created-secret',
            name: body.name,
            group_id: 12,
            status: 'active',
            ...(unlimited ? {} : { quota: 1 }),
          },
        });
      }
      expect(url.pathname).toBe('/api/v1/keys');
      expect(url.search).toBe('?page=1&page_size=1000');
      return json({
        code: 0,
        data: {
          items: [{
            id: 90,
            key: 'sk-existing-secret',
            name: 'Existing group key',
            group_id: 12,
            status: 'active',
            quota: 2,
            quota_used: 0.25,
            group: { id: 12, name: 'Group 12' },
          }],
          total: 1,
          page: 1,
          page_size: 1000,
          pages: 1,
        },
      });
    });
    const ctx = context(fetch, { access_token: 'access' });
    await expect(listSub2ApiProbeApiKeys(ctx)).resolves.toEqual([expect.objectContaining({
      id: '90',
      groupId: '12',
      secretKey: 'sk-existing-secret',
    })]);
    await expect(createSub2ApiProbeApiKey(ctx, {
      name: 'Relay Monitor group 12',
      groupId: '12',
      quota: 1,
      expiresInDays: 3,
      idempotencyKey: 'relay-key-create-1',
    })).resolves.toEqual(expect.objectContaining({
      id: '91',
      secretKey: 'sk-created-secret',
    }));
    await expect(createSub2ApiProbeApiKey(ctx, {
      name: 'Relay Monitor unlimited group 12',
      groupId: '12',
      idempotencyKey: 'relay-key-create-unlimited',
    })).resolves.toEqual(expect.objectContaining({
      id: '92',
      quota: null,
      expiresAt: null,
      secretKey: 'sk-created-secret',
    }));
    await expect(deleteSub2ApiProbeApiKey(ctx, '91')).resolves.toBeUndefined();
  });

  it('keeps authentication failures distinct from network failures', async () => {
    const unauthorized = fakeFetch(() => json({ code: 401, message: 'expired' }, 401));
    const authResult = await collectSub2ApiConnectivity(context(unauthorized, { api_key: 'bad-key' }));
    expect(authResult).toMatchObject({
      status: 'degraded',
      authenticated: false,
      errorCode: 'AUTH_ACCESS_EXPIRED',
    });

    const unreachable = fakeFetch(() => Promise.reject(new TypeError('connect ECONNREFUSED')));
    const networkResult = await collectSub2ApiConnectivity(context(unreachable, { api_key: 'key' }));
    expect(networkResult).toMatchObject({
      status: 'down',
      authenticated: null,
      errorCode: 'UPSTREAM_UNREACHABLE',
    });
  });

  it('classifies Retry-After without leaking the upstream body', async () => {
    const fetch = fakeFetch(() => json({ secret: 'must-not-leak' }, 429, { 'Retry-After': '12' }));
    await expect(
      new Sub2ApiClient({ baseUrl: 'https://relay.example', fetch }).request('/api/v1/groups/available', {
        schema: groupsSchema,
      }),
    ).rejects.toMatchObject<Partial<AdapterError>>({
      code: 'UPSTREAM_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 12_000,
    });
  });

  it('keeps HTTP server and redirect classification even when the body is not JSON', async () => {
    const serverError = fakeFetch(() => new Response('<html>unavailable</html>', { status: 503 }));
    await expect(
      new Sub2ApiClient({ baseUrl: 'https://relay.example', fetch: serverError }).request(
        '/api/v1/groups/available',
        { schema: groupsSchema },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_SERVER_ERROR', httpStatus: 503 });

    const redirect = fakeFetch(() =>
      new Response('redirecting', { status: 302, headers: { Location: 'https://other.example' } }),
    );
    await expect(
      new Sub2ApiClient({ baseUrl: 'https://relay.example', fetch: redirect }).request(
        '/api/v1/groups/available',
        { schema: groupsSchema },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNREACHABLE', httpStatus: 302 });
  });

  it('parses Responses CRLF and UTF-8 split SSE with timing, usage, and upstream tools', async () => {
    const streamText = [
      `data: ${JSON.stringify({
        type: 'response.created',
        response: {
          model: 'gpt-5.6-sol',
          status: 'in_progress',
          system_fingerprint: 'fp_weak',
          tools: [{ type: 'function', name: 'injected_tool' }],
        },
      })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '\u6d4b' })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '\u8bd5' })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.done', text: '\u6d4b\u8bd5' })}\r\n\r\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          status: 'completed',
          system_fingerprint: 'fp_weak',
          output: [{ type: 'message', role: 'assistant' }],
          tools: [],
          usage: {
            input_tokens: 123,
            output_tokens: 24,
            total_tokens: 147,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 6 },
          },
        },
      })}\r\n\r\n`,
    ].join('');
    const bytes = new TextEncoder().encode(streamText);
    const firstCr = bytes.indexOf(13);
    const utfStart = bytes.findIndex((value, index) =>
      value === 0xe6 && bytes[index + 1] === 0xb5 && bytes[index + 2] === 0x8b
    );
    expect(firstCr).toBeGreaterThan(0);
    expect(utfStart).toBeGreaterThan(firstCr);
    const splitPoints = [firstCr + 1, utfStart + 1, utfStart + 2];
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (const point of splitPoints) {
      chunks.push(bytes.slice(offset, point));
      offset = point;
    }
    chunks.push(bytes.slice(offset));
    const fetch = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/v1/responses');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-probe');
      expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream');
      expect(JSON.parse(String(init.body))).toEqual({
        model: 'gpt-5.6-sol',
        instructions: 'Fixed system prompt',
        input: 'Fixed user prompt',
        stream: true,
        store: false,
        tools: [],
        tool_choice: 'none',
        max_output_tokens: 96,
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const now = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(250)
      .mockReturnValueOnce(1_000);
    try {
      const result = await probeSub2ApiModel(context(fetch, { api_key: 'sk-probe' }), {
        model: 'gpt-5.6-sol',
        maxOutputTokens: 96,
        systemPrompt: 'Fixed system prompt',
        userPrompt: 'Fixed user prompt',
      });
      expect(result).toMatchObject({
        requestedModel: 'gpt-5.6-sol',
        returnedModel: 'gpt-5.6-sol',
        ttfbMs: 100,
        ttftMs: 250,
        totalMs: 1_000,
        generationMs: 750,
        tps: '24',
        finishReason: 'stop',
        systemFingerprint: 'fp_weak',
        toolCallsObserved: false,
        upstreamToolsObserved: true,
        outputText: '\u6d4b\u8bd5',
        usage: {
          promptTokens: 123,
          completionTokens: 24,
          totalTokens: 147,
          cachedInputTokens: 10,
          reasoningTokens: 6,
        },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('excludes reasoning tokens from post-TTFT throughput and falls back when unavailable', () => {
    expect(visibleOutputTps(24, 6, 750)).toBe('24');
    expect(visibleOutputTps(24, null, 750)).toBe('32');
    expect(visibleOutputTps(null, 6, 750)).toBeNull();
    expect(visibleOutputTps(24, 6, null)).toBeNull();
  });

  it('keeps missing usage null and detects Responses output tool items', async () => {
    const payload = [
      `data: ${JSON.stringify({
        type: 'response.output_item.added',
        item: { id: 'call_1', type: 'function_call', name: 'unexpected' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.6-sol',
          status: 'completed',
          output: [{ id: 'call_1', type: 'function_call', name: 'unexpected' }],
          tools: [],
        },
      })}\n\n`,
    ].join('');
    const fetch = fakeFetch(() => new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const result = await probeSub2ApiModel(context(fetch, { api_key: 'sk-probe' }), {
      model: 'gpt-5.6-sol',
      maxOutputTokens: 32,
      systemPrompt: 'Fixed system prompt',
      userPrompt: 'Fixed user prompt',
    });
    expect(result).toMatchObject({
      ttftMs: null,
      generationMs: null,
      tps: null,
      finishReason: 'stop',
      toolCallsObserved: true,
      upstreamToolsObserved: false,
      outputText: '',
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
  });

  it('extracts terminal Responses message text and refusals when a gateway omits deltas', async () => {
    const cases = [
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{
            type: 'message',
            content: [
              { type: 'output_text', text: 'Fallback: ' },
              { type: 'refusal', refusal: 'blocked' },
            ],
          }],
          tools: [],
        },
        finishReason: 'stop',
      },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          output: [{
            type: 'message',
            content: [
              { type: 'output_text', text: 'Fallback: ' },
              { type: 'refusal', refusal: 'blocked' },
            ],
          }],
          tools: [],
        },
        finishReason: 'content_filter',
      },
    ] as const;

    for (const testCase of cases) {
      const payload = `data: ${JSON.stringify({
        type: testCase.type,
        response: testCase.response,
      })}\n\n`;
      const fetch = fakeFetch(() => new Response(payload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
      const result = await probeSub2ApiModel(context(fetch, { api_key: 'sk-probe' }), {
        model: 'gpt-5.6-sol',
        maxOutputTokens: 32,
        systemPrompt: 'Fixed system prompt',
        userPrompt: 'Fixed user prompt',
      });
      expect(result).toMatchObject({
        outputText: 'Fallback: blocked',
        finishReason: testCase.finishReason,
        toolCallsObserved: false,
        upstreamToolsObserved: false,
      });
      expect(result.ttftMs).not.toBeNull();
    }
  });

  it('maps a Responses max_output_tokens incomplete result to length', async () => {
    const payload = `data: ${JSON.stringify({
      type: 'response.incomplete',
      response: {
        model: 'gpt-5.6-sol',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning' }],
        usage: {
          input_tokens: 40,
          output_tokens: 1,
          total_tokens: 41,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    })}\n\n`;
    const fetch = fakeFetch(() => new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const result = await probeSub2ApiModel(context(fetch, { api_key: 'sk-probe' }), {
      model: 'gpt-5.6-sol',
      maxOutputTokens: 1,
      systemPrompt: 'Fixed system prompt',
      userPrompt: 'Fixed user prompt',
    });
    expect(result).toMatchObject({
      ttftMs: null,
      generationMs: null,
      tps: null,
      finishReason: 'length',
      toolCallsObserved: false,
      upstreamToolsObserved: false,
      outputText: '',
      usage: { completionTokens: 1, reasoningTokens: 1 },
    });
  });

  it('rejects oversized Responses metadata and internally inconsistent usage', async () => {
    const request = {
      model: 'gpt-test',
      maxOutputTokens: 32,
      systemPrompt: 'Fixed system prompt',
      userPrompt: 'Fixed user prompt',
    };
    const oversized = fakeFetch(() => new Response([
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { model: 'x'.repeat(201), status: 'completed', output: [], tools: [] },
      })}\n\n`,
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    await expect(probeSub2ApiModel(context(oversized, { api_key: 'sk-probe' }), request))
      .rejects.toMatchObject({ code: 'UPSTREAM_SCHEMA_ERROR' });

    const inconsistent = fakeFetch(() => new Response([
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message' }],
          tools: [],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 99,
            input_tokens_details: { cached_tokens: 11 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      })}\n\n`,
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    await expect(probeSub2ApiModel(context(inconsistent, { api_key: 'sk-probe' }), request))
      .rejects.toMatchObject({ code: 'UPSTREAM_SCHEMA_ERROR' });
  });

  it('classifies Responses failed and error events without exposing upstream details', async () => {
    const request = {
      model: 'gpt-test',
      maxOutputTokens: 32,
      systemPrompt: 'Fixed system prompt',
      userPrompt: 'Fixed user prompt',
    };
    const failed = fakeFetch(() => new Response(
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { status: 'failed', error: { message: 'secret upstream detail' } },
      })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    await expect(probeSub2ApiModel(context(failed, { api_key: 'sk-probe' }), request))
      .rejects.toMatchObject({
        code: 'UPSTREAM_SERVER_ERROR',
        message: 'The upstream model response failed',
      });

    const streamError = fakeFetch(() => new Response(
      `data: ${JSON.stringify({ type: 'error', error: { message: 'another secret' } })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    await expect(probeSub2ApiModel(context(streamError, { api_key: 'sk-probe' }), request))
      .rejects.toMatchObject({
        code: 'UPSTREAM_SERVER_ERROR',
        message: 'The upstream model stream returned an error',
      });
  });

  it('lists and de-duplicates probe models with the dedicated API key', async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/v1/models');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-probe');
      return json({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-b' }] });
    });
    const catalog = await listSub2ApiProbeModels(context(fetch, { api_key: 'sk-probe' }));
    expect(catalog.models).toEqual([{ id: 'gpt-a' }, { id: 'gpt-b' }]);
  });
});
