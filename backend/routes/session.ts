import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import {
  admins,
  adminSessions,
  type DatabaseConnection,
} from '../db/index.js';
import { success } from '../core/api-response.js';
import { AppError } from '../core/errors.js';
import { createId } from '../core/ids.js';
import {
  adminPasswordNeedsRehash,
  assertValidAdminPassword,
  hashAdminPassword,
  normalizeAdminUsername,
  verifyAdminPassword,
} from '../core/password.js';
import { recordAudit } from '../core/audit.js';
import {
  createSessionSecrets,
  hashSessionSecret,
  SESSION_TTL_SECONDS,
  sessionCookieName,
  sessionSecretMatches,
} from '../core/session-security.js';

const CSRF_COOKIE_SECURE = '__Host-relaymon_csrf';
const CSRF_COOKIE_INSECURE = 'relaymon_csrf';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AdminIdentity {
  id: string;
  username: string;
  displayName: string;
}

export interface SessionIdentity {
  id: string;
  csrfTokenHash: string;
  expiresAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    relayAdmin: AdminIdentity | null;
    relaySession: SessionIdentity | null;
  }
}

export interface SessionDependencies {
  config: AppConfig;
  database: DatabaseConnection;
  secureCookies: boolean;
}

function csrfCookieName(secure: boolean): string {
  return secure ? CSRF_COOKIE_SECURE : CSRF_COOKIE_INSECURE;
}

function cookieOptions(secure: boolean, httpOnly: boolean) {
  return {
    path: '/',
    httpOnly,
    secure,
    sameSite: 'strict' as const,
    maxAge: SESSION_TTL_SECONDS,
  };
}

function clearSessionCookies(reply: FastifyReply, secureCookies: boolean): void {
  reply.clearCookie(sessionCookieName(secureCookies), cookieOptions(secureCookies, true));
  reply.clearCookie(csrfCookieName(secureCookies), cookieOptions(secureCookies, false));
}

function publicAdmin(admin: AdminIdentity, csrfToken: string, config: AppConfig) {
  return {
    id: admin.id,
    username: admin.username,
    display_name: admin.displayName,
    timezone: config.timezone,
    csrf_token: csrfToken,
  };
}

function sessionFromRequest(request: FastifyRequest, dependencies: SessionDependencies) {
  const token = request.cookies[sessionCookieName(dependencies.secureCookies)];
  if (!token || token.length > 256) return undefined;
  const now = new Date().toISOString();
  return dependencies.database.db
    .select({
      sessionId: adminSessions.id,
      csrfTokenHash: adminSessions.csrfTokenHash,
      expiresAt: adminSessions.expiresAt,
      adminId: admins.id,
      username: admins.username,
      displayName: admins.displayName,
    })
    .from(adminSessions)
    .innerJoin(admins, eq(adminSessions.adminId, admins.id))
    .where(
      and(
        eq(adminSessions.tokenHash, hashSessionSecret(token)),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, now),
        eq(admins.isActive, true),
      ),
    )
    .get();
}

export function authenticateAdminRequest(
  request: FastifyRequest,
  dependencies: SessionDependencies,
): void {
  const resolved = sessionFromRequest(request, dependencies);
  if (!resolved) throw new AppError('SESSION_REQUIRED', '请先登录管理端', 401);

  request.relayAdmin = {
    id: resolved.adminId,
    username: resolved.username,
    displayName: resolved.displayName,
  };
  request.relaySession = {
    id: resolved.sessionId,
    csrfTokenHash: resolved.csrfTokenHash,
    expiresAt: resolved.expiresAt,
  };

  if (UNSAFE_METHODS.has(request.method)) {
    const header = request.headers['x-csrf-token'];
    const csrfHeader = Array.isArray(header) ? header[0] : header;
    const csrfCookie = request.cookies[csrfCookieName(dependencies.secureCookies)];
    if (
      !csrfHeader ||
      !csrfCookie ||
      csrfHeader !== csrfCookie ||
      !sessionSecretMatches(csrfHeader, resolved.csrfTokenHash)
    ) {
      throw new AppError('CSRF_TOKEN_INVALID', '安全令牌无效，请刷新页面后重试', 403);
    }
  }

  dependencies.database.db
    .update(adminSessions)
    .set({ lastSeenAt: new Date().toISOString() })
    .where(eq(adminSessions.id, resolved.sessionId))
    .run();
}

function failedLockUntil(currentFailures: number): string | null {
  const nextFailures = currentFailures + 1;
  if (nextFailures < 5) return null;
  const delaySeconds = Math.min(15 * 60, 30 * 2 ** Math.min(nextFailures - 5, 5));
  return new Date(Date.now() + delaySeconds * 1_000).toISOString();
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: SessionDependencies,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const dummyPasswordHash = await hashAdminPassword('relay-monitor-dummy-password-for-timing-only');

  typed.post(
    '/api/v1/session/login',
    {
      config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
      schema: {
        tags: ['session'],
        summary: '管理员登录',
        body: z.object({
          username: z.string().min(1).max(64),
          password: z.string().min(1).max(1_024),
        }),
      },
    },
    async (request, reply) => {
      let username = '';
      try {
        username = normalizeAdminUsername(request.body.username);
      } catch {
        // Continue through the same Argon2 path as a known username.
      }
      const admin = username
        ? dependencies.database.db.select().from(admins).where(eq(admins.username, username)).get()
        : undefined;
      const locked = admin?.lockedUntil && admin.lockedUntil > new Date().toISOString();
      const passwordValid = await verifyAdminPassword(admin?.passwordHash ?? dummyPasswordHash, request.body.password);
      const valid = Boolean(admin && admin.isActive && !locked && passwordValid);

      if (!valid || !admin) {
        if (admin) {
          dependencies.database.sqlite.transaction(() => {
            const current = dependencies.database.db.select().from(admins)
              .where(eq(admins.id, admin.id)).get();
            if (current) {
              dependencies.database.db
                .update(admins)
                .set({
                  failedLoginCount: current.failedLoginCount + 1,
                  lockedUntil: failedLockUntil(current.failedLoginCount),
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(admins.id, admin.id))
                .run();
            }
            recordAudit(dependencies.database, request, {
              action: 'session.login_failed',
              resourceType: 'admin',
              adminId: admin.id,
              resourceId: admin.id,
              metadata: { username, locked: Boolean(locked) },
            });
          }).immediate();
        } else {
          recordAudit(dependencies.database, request, {
            action: 'session.login_failed',
            resourceType: 'admin',
            metadata: { username: username || '<invalid>', locked: false },
          });
        }
        throw new AppError(
          locked ? 'LOGIN_TEMPORARILY_LOCKED' : 'INVALID_CREDENTIALS',
          locked ? '登录暂时锁定，请稍后重试' : '用户名或密码错误',
          locked ? 429 : 401,
        );
      }

      if (adminPasswordNeedsRehash(admin.passwordHash)) {
        const passwordHash = await hashAdminPassword(request.body.password);
        dependencies.database.db.update(admins).set({ passwordHash }).where(eq(admins.id, admin.id)).run();
      }

      const secrets = createSessionSecrets();
      const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1_000).toISOString();
      dependencies.database.sqlite.transaction(() => {
        dependencies.database.db.insert(adminSessions).values({
          id: createId('session'),
          adminId: admin.id,
          tokenHash: secrets.tokenHash,
          csrfTokenHash: secrets.csrfTokenHash,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent']?.slice(0, 500) ?? null,
          expiresAt,
        }).run();
        dependencies.database.db.update(admins).set({
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).where(eq(admins.id, admin.id)).run();
        recordAudit(dependencies.database, request, {
          action: 'session.login',
          resourceType: 'admin',
          resourceId: admin.id,
          adminId: admin.id,
        });
      })();

      reply.setCookie(
        sessionCookieName(dependencies.secureCookies),
        secrets.token,
        cookieOptions(dependencies.secureCookies, true),
      );
      reply.setCookie(
        csrfCookieName(dependencies.secureCookies),
        secrets.csrfToken,
        cookieOptions(dependencies.secureCookies, false),
      );
      return success(request, publicAdmin({
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
      }, secrets.csrfToken, dependencies.config));
    },
  );

  typed.get(
    '/api/v1/session/me',
    { schema: { tags: ['session'], summary: '读取当前管理员会话' } },
    async (request, reply) => {
      if (!request.relayAdmin || !request.relaySession) {
        throw new AppError('SESSION_REQUIRED', '请先登录管理端', 401);
      }
      let csrfToken = request.cookies[csrfCookieName(dependencies.secureCookies)];
      if (!csrfToken || !sessionSecretMatches(csrfToken, request.relaySession.csrfTokenHash)) {
        const next = createSessionSecrets();
        csrfToken = next.csrfToken;
        dependencies.database.db.update(adminSessions).set({
          csrfTokenHash: next.csrfTokenHash,
        }).where(eq(adminSessions.id, request.relaySession.id)).run();
        reply.setCookie(
          csrfCookieName(dependencies.secureCookies),
          csrfToken,
          cookieOptions(dependencies.secureCookies, false),
        );
      }
      return success(request, publicAdmin(request.relayAdmin, csrfToken, dependencies.config));
    },
  );

  typed.put(
    '/api/v1/session/password',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        tags: ['session'],
        summary: '修改当前管理员密码',
        body: z.object({
          current_password: z.string()
            .min(1, '请输入当前密码')
            .max(1_024, '当前密码长度无效'),
          new_password: z.string()
            .min(1, '请输入新密码')
            .max(1_024, '新密码长度无效'),
        }),
      },
    },
    async (request) => {
      const adminId = request.relayAdmin?.id;
      const currentSessionId = request.relaySession?.id;
      if (!adminId || !currentSessionId) {
        throw new AppError('SESSION_REQUIRED', '请先登录管理端', 401);
      }

      const admin = dependencies.database.db.select().from(admins).where(eq(admins.id, adminId)).get();
      const currentPasswordValid = Boolean(
        admin && await verifyAdminPassword(admin.passwordHash, request.body.current_password),
      );
      if (!currentPasswordValid || !admin) {
        recordAudit(dependencies.database, request, {
          action: 'admin.password_change_failed',
          resourceType: 'admin',
          resourceId: adminId,
          metadata: { reason: 'invalid_current_password' },
        });
        throw new AppError('CURRENT_PASSWORD_INVALID', '当前密码不正确', 401);
      }

      try {
        assertValidAdminPassword(request.body.new_password);
      } catch {
        recordAudit(dependencies.database, request, {
          action: 'admin.password_change_failed',
          resourceType: 'admin',
          resourceId: adminId,
          metadata: { reason: 'password_policy' },
        });
        throw new AppError(
          'PASSWORD_POLICY_VIOLATION',
          '新密码至少需要 12 个字符、UTF-8 编码不能超过 1024 字节，且不能包含空字符',
          400,
        );
      }
      if (await verifyAdminPassword(admin.passwordHash, request.body.new_password)) {
        throw new AppError('PASSWORD_UNCHANGED', '新密码不能与当前密码相同', 400);
      }

      const passwordHash = await hashAdminPassword(request.body.new_password);
      const changedAt = new Date().toISOString();
      let revokedSessionCount = 0;
      dependencies.database.sqlite.transaction(() => {
        const updated = dependencies.database.db.update(admins).set({
          passwordHash,
          passwordChangedAt: changedAt,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: changedAt,
        }).where(and(eq(admins.id, adminId), eq(admins.passwordHash, admin.passwordHash))).run();
        if (updated.changes !== 1) {
          throw new AppError('PASSWORD_CHANGED_CONCURRENTLY', '密码已被其他请求修改，请重新登录后再试', 409);
        }

        revokedSessionCount = dependencies.database.db.update(adminSessions).set({
          revokedAt: changedAt,
        }).where(and(
          eq(adminSessions.adminId, adminId),
          ne(adminSessions.id, currentSessionId),
          isNull(adminSessions.revokedAt),
          gt(adminSessions.expiresAt, changedAt),
        )).run().changes;
        recordAudit(dependencies.database, request, {
          action: 'admin.password_change',
          resourceType: 'admin',
          resourceId: adminId,
          metadata: { revoked_session_count: revokedSessionCount },
        });
      }).immediate();

      return success(request, { revoked_session_count: revokedSessionCount });
    },
  );

  typed.post(
    '/api/v1/session/logout',
    { schema: { tags: ['session'], summary: '注销当前会话' } },
    async (request, reply) => {
      dependencies.database.sqlite.transaction(() => {
        if (request.relaySession) {
          dependencies.database.db.update(adminSessions).set({
            revokedAt: new Date().toISOString(),
          }).where(eq(adminSessions.id, request.relaySession.id)).run();
        }
        recordAudit(dependencies.database, request, {
          action: 'session.logout',
          resourceType: 'admin',
          resourceId: request.relayAdmin?.id ?? null,
        });
      })();
      clearSessionCookies(reply, dependencies.secureCookies);
      return success(request, null);
    },
  );
}
