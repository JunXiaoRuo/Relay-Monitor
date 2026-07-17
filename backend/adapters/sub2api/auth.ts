import type {
  AuthResult,
  AuthenticatedResult,
  AuthUpdate,
  CredentialInput,
  SiteContext,
} from '../contracts/types.js';
import { AdapterError, isAdapterError } from '../contracts/errors.js';
import { Sub2ApiClient, type Sub2ApiResponse } from './client.js';
import {
  loginResponseSchema,
  publicSettingsSchema,
  tokenResponseSchema,
  twoFactorResponseSchema,
  type TokenResponse,
  userProfileSchema,
} from './schemas.js';
import { sub2ApiCredentialSchema } from './manifest.js';

export function createSub2ApiClient(ctx: SiteContext): Sub2ApiClient {
  return new Sub2ApiClient({
    baseUrl: ctx.baseUrl,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}

function expiresAt(expiresIn: number | undefined, now: Date): string | undefined {
  if (expiresIn === undefined) return undefined;
  return new Date(now.getTime() + expiresIn * 1_000).toISOString();
}

function authenticatedResult(token: TokenResponse, now: Date): AuthenticatedResult {
  const expiry = expiresAt(token.expires_in, now);
  const tokens = {
    accessToken: token.access_token,
    tokenType: token.token_type,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(expiry ? { expiresAt: expiry } : {}),
  };
  const user = token.user
    ? {
        ...(token.user.id ? { id: token.user.id } : {}),
        ...(token.user.email ? { email: token.user.email } : {}),
        ...(token.user.username ? { username: token.user.username } : {}),
      }
    : undefined;
  return {
    status: 'authenticated',
    tokens,
    ...(user ? { user } : {}),
  };
}

function authUpdate(result: AuthenticatedResult): AuthUpdate {
  return {
    accessToken: result.tokens.accessToken,
    ...(result.tokens.refreshToken ? { refreshToken: result.tokens.refreshToken } : {}),
    ...(result.tokens.expiresAt ? { expiresAt: result.tokens.expiresAt } : {}),
  };
}

function stringValue(input: CredentialInput, key: string): string | undefined {
  const value = input.values[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function requiresGeetestVerification(ctx: SiteContext): Promise<boolean> {
  try {
    const response = await createSub2ApiClient(ctx).request('/api/v1/settings/public', {
      schema: publicSettingsSchema,
      optionalCapability: true,
    });
    return response.data.geetest_enabled;
  } catch (error) {
    // Older Sub2API deployments may not expose public settings. Authentication
    // remains the compatibility fallback in that case.
    if (
      isAdapterError(error, 'UPSTREAM_CAPABILITY_UNSUPPORTED')
      || isAdapterError(error, 'UPSTREAM_SCHEMA_ERROR')
      || isAdapterError(error, 'AUTH_ACCESS_EXPIRED')
    ) {
      return false;
    }
    throw error;
  }
}

export async function completeSub2ApiTwoFactor(
  ctx: SiteContext,
  temporaryToken: string,
  totpCode: string,
): Promise<AuthenticatedResult> {
  const response = await createSub2ApiClient(ctx).request('/api/v1/auth/login/2fa', {
    method: 'POST',
    body: { temp_token: temporaryToken, totp_code: totpCode },
    schema: tokenResponseSchema,
    authFailureCode: 'AUTH_INVALID_CREDENTIALS',
  });
  return authenticatedResult(response.data, ctx.now ?? new Date());
}

export async function authenticateSub2Api(
  ctx: SiteContext,
  rawInput: CredentialInput,
): Promise<AuthResult> {
  const input = sub2ApiCredentialSchema.parse(rawInput);
  const temporaryToken = stringValue(input, 'temp_token');
  const totpCode = stringValue(input, 'totp_code');
  if (temporaryToken && totpCode) {
    return completeSub2ApiTwoFactor(ctx, temporaryToken, totpCode);
  }

  if (input.mode === 'token') {
    const accessToken = stringValue(input, 'access_token');
    if (!accessToken) {
      throw new AdapterError('AUTH_ACCESS_EXPIRED', '必须填写 Access Token');
    }
    const profile = await createSub2ApiClient(ctx).request('/api/v1/auth/me', {
      bearerToken: accessToken,
      schema: userProfileSchema,
      authFailureCode: 'AUTH_ACCESS_EXPIRED',
    });
    const refreshToken = stringValue(input, 'refresh_token');
    return {
      status: 'authenticated',
      tokens: {
        accessToken,
        tokenType: 'Bearer',
        ...(refreshToken ? { refreshToken } : {}),
      },
      user: {
        ...(profile.data.id ? { id: profile.data.id } : {}),
        ...(profile.data.email ? { email: profile.data.email } : {}),
        ...(profile.data.username ? { username: profile.data.username } : {}),
      },
    };
  }

  if (await requiresGeetestVerification(ctx)) {
    return {
      status: 'interaction_required',
      challenge: 'other',
      message: '目标站点已启用 Geetest 人机验证，Relay Monitor 不会绕过验证。请先在站点网页登录，再改用 Access Token 添加中转站。',
    };
  }

  try {
    const response = await createSub2ApiClient(ctx).request('/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: stringValue(input, 'email') ?? '',
        password: stringValue(input, 'password') ?? '',
        turnstile_token: stringValue(input, 'turnstile_token') ?? '',
      },
      schema: loginResponseSchema,
      authFailureCode: 'AUTH_INVALID_CREDENTIALS',
    });
    const challenge = twoFactorResponseSchema.safeParse(response.data);
    if (challenge.success) {
      return {
        status: 'interaction_required',
        challenge: 'two_factor',
        temporaryToken: challenge.data.temp_token,
        ...(challenge.data.user_email_masked
          ? { maskedIdentity: challenge.data.user_email_masked }
          : {}),
        message: '目标站点要求输入 TOTP 二次验证码。',
      };
    }
    return authenticatedResult(tokenResponseSchema.parse(response.data), ctx.now ?? new Date());
  } catch (error) {
    if (isAdapterError(error, 'AUTH_INTERACTION_REQUIRED')) {
      return {
        status: 'interaction_required',
        challenge: 'turnstile',
        message: '目标站点要求完成人工验证，请在站点页面验证后再提供 Token。',
      };
    }
    throw error;
  }
}

export async function refreshSub2ApiAuth(ctx: SiteContext): Promise<AuthenticatedResult> {
  const refreshToken = ctx.credentials?.refresh_token;
  if (!refreshToken) {
    throw new AdapterError('AUTH_REFRESH_FAILED', '没有可用的 Refresh Token');
  }
  const response = await createSub2ApiClient(ctx).request('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
    schema: tokenResponseSchema,
    authFailureCode: 'AUTH_REFRESH_FAILED',
  });
  return authenticatedResult(response.data, ctx.now ?? new Date());
}

function automaticReauthenticationEnabled(ctx: SiteContext): boolean {
  const value = ctx.credentials?.auto_reauthenticate;
  return value === 'true' || value === '1';
}

function shouldProactivelyRefresh(ctx: SiteContext): boolean {
  if (!ctx.credentials?.refresh_token) return false;
  const expiresAt = ctx.credentials.access_expires_at;
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - (ctx.now ?? new Date()).getTime() < 10 * 60_000;
}

async function reauthenticateFromStoredPassword(ctx: SiteContext): Promise<AuthResult> {
  const email = ctx.credentials?.email;
  const password = ctx.credentials?.password;
  if (!automaticReauthenticationEnabled(ctx) || !email || !password) {
    throw new AdapterError('AUTH_REFRESH_FAILED', '登录状态刷新失败，且未启用账号密码自动重新登录');
  }
  return authenticateSub2Api(ctx, {
    mode: 'password',
    values: { email, password },
  });
}

export async function refreshOrReauthenticateSub2Api(ctx: SiteContext): Promise<AuthResult> {
  try {
    return await refreshSub2ApiAuth(ctx);
  } catch (error) {
    if (!isAdapterError(error, 'AUTH_REFRESH_FAILED')) throw error;
    return reauthenticateFromStoredPassword(ctx);
  }
}

async function requireRefreshedAuthentication(ctx: SiteContext): Promise<AuthenticatedResult> {
  const result = await refreshOrReauthenticateSub2Api(ctx);
  if (result.status !== 'authenticated') {
    throw new AdapterError(
      result.challenge === 'two_factor' ? 'AUTH_2FA_REQUIRED' : 'AUTH_INTERACTION_REQUIRED',
      result.message,
    );
  }
  return result;
}

export interface AuthenticatedRequestResult<T> extends Sub2ApiResponse<T> {
  authUpdate?: AuthUpdate;
}

export async function requestWithSub2ApiAuth<T>(
  ctx: SiteContext,
  request: (client: Sub2ApiClient, accessToken: string) => Promise<Sub2ApiResponse<T>>,
): Promise<AuthenticatedRequestResult<T>> {
  const accessToken = ctx.credentials?.access_token;
  if (!accessToken) throw new AdapterError('AUTH_ACCESS_EXPIRED', 'Access token is unavailable');
  const client = createSub2ApiClient(ctx);
  if (shouldProactivelyRefresh(ctx)) {
    const refreshed = await requireRefreshedAuthentication(ctx);
    const update = authUpdate(refreshed);
    await ctx.onAuthUpdate?.(update);
    const response = await request(client, refreshed.tokens.accessToken);
    return { ...response, authUpdate: update };
  }
  try {
    return await request(client, accessToken);
  } catch (error) {
    if (!isAdapterError(error, 'AUTH_ACCESS_EXPIRED')) throw error;
  }

  const refreshed = await requireRefreshedAuthentication(ctx);
  const retried = await request(client, refreshed.tokens.accessToken);
  const update = authUpdate(refreshed);
  await ctx.onAuthUpdate?.(update);
  return { ...retried, authUpdate: update };
}
