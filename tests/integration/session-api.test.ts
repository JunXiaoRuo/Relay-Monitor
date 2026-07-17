import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import { createAppContext } from '../../backend/context.js';
import { adminSessions, admins, auditLogs } from '../../backend/db/index.js';
import { createId } from '../../backend/core/ids.js';
import { hashAdminPassword, verifyAdminPassword } from '../../backend/core/password.js';

const temporaryDirectories: string[] = [];

function cookiesFrom(headers: string | string[] | undefined): string {
  const values = Array.isArray(headers) ? headers : headers ? [headers] : [];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('administrator session API', () => {
  it('uses an HttpOnly session and a session-bound CSRF token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-api-'));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: join(directory, 'master.key'),
      LOG_LEVEL: 'silent',
    });
    const context = createAppContext(config);
    context.database.db.insert(admins).values({
      id: createId('admin'),
      username: 'admin',
      displayName: 'Test Admin',
      passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
    }).run();
    const app = await buildApp({ context, closeContext: false, startScheduler: false });

    try {
      await app.ready();
      const anonymous = await app.inject({ method: 'GET', url: '/api/v1/adapters' });
      expect(anonymous.statusCode).toBe(401);

      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);
      expect(login.body).not.toContain('correct-horse-battery-staple');
      const loginBody = login.json() as { data: { csrf_token: string; username: string } };
      expect(loginBody.data.username).toBe('admin');
      expect(loginBody.data.csrf_token.length).toBeGreaterThan(20);
      const cookie = cookiesFrom(login.headers['set-cookie']);
      expect(cookie).toContain('relaymon_session=');
      expect(cookie).toContain('relaymon_csrf=');

      const authenticated = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters',
        headers: { cookie },
      });
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json().data[0].adapter_type).toBe('sub2api');

      const missingCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/session/logout',
        headers: { cookie },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json().error.code).toBe('CSRF_TOKEN_INVALID');

      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/session/logout',
        headers: {
          cookie,
          'x-csrf-token': loginBody.data.csrf_token,
        },
      });
      expect(logout.statusCode).toBe(200);
    } finally {
      await app.close();
      await context.close();
    }
  });

  it('changes the password only after verification and revokes other sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-password-api-'));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: join(directory, 'master.key'),
      LOG_LEVEL: 'silent',
    });
    const context = createAppContext(config);
    const adminId = createId('admin');
    context.database.db.insert(admins).values({
      id: adminId,
      username: 'admin',
      displayName: 'Test Admin',
      passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
    }).run();
    const app = await buildApp({ context, closeContext: false, startScheduler: false });

    try {
      await app.ready();
      const firstLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      const secondLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      const firstCookie = cookiesFrom(firstLogin.headers['set-cookie']);
      const secondCookie = cookiesFrom(secondLogin.headers['set-cookie']);
      const csrf = (secondLogin.json() as { data: { csrf_token: string } }).data.csrf_token;
      const headers = { cookie: secondCookie, 'x-csrf-token': csrf };

      const missingCsrf = await app.inject({
        method: 'PUT',
        url: '/api/v1/session/password',
        headers: { cookie: secondCookie },
        payload: { current_password: 'correct-horse-battery-staple', new_password: 'replacement secure passphrase' },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json().error.code).toBe('CSRF_TOKEN_INVALID');

      const incorrect = await app.inject({
        method: 'PUT',
        url: '/api/v1/session/password',
        headers,
        payload: { current_password: 'incorrect-password', new_password: 'replacement secure passphrase' },
      });
      expect(incorrect.statusCode).toBe(401);
      expect(incorrect.json().error.code).toBe('CURRENT_PASSWORD_INVALID');

      const weak = await app.inject({
        method: 'PUT',
        url: '/api/v1/session/password',
        headers,
        payload: { current_password: 'correct-horse-battery-staple', new_password: 'too-short' },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().error.code).toBe('PASSWORD_POLICY_VIOLATION');

      const changed = await app.inject({
        method: 'PUT',
        url: '/api/v1/session/password',
        headers,
        payload: {
          current_password: 'correct-horse-battery-staple',
          new_password: 'replacement secure passphrase',
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().data.revoked_session_count).toBe(1);

      const updatedAdmin = context.database.db.select().from(admins).where(eq(admins.id, adminId)).get();
      expect(updatedAdmin).toBeDefined();
      expect(await verifyAdminPassword(updatedAdmin!.passwordHash, 'replacement secure passphrase')).toBe(true);
      expect(await verifyAdminPassword(updatedAdmin!.passwordHash, 'correct-horse-battery-staple')).toBe(false);
      expect(context.database.db.select().from(adminSessions)
        .where(eq(adminSessions.adminId, adminId)).all().filter((row) => row.revokedAt !== null)).toHaveLength(1);

      const revokedSession = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters',
        headers: { cookie: firstCookie },
      });
      expect(revokedSession.statusCode).toBe(401);
      const currentSession = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters',
        headers: { cookie: secondCookie },
      });
      expect(currentSession.statusCode).toBe(200);

      const actions = context.database.db.select({ action: auditLogs.action }).from(auditLogs).all();
      expect(actions.filter((row) => row.action === 'admin.password_change_failed')).toHaveLength(2);
      expect(actions.some((row) => row.action === 'admin.password_change')).toBe(true);
    } finally {
      await app.close();
      await context.close();
    }
  });
});
