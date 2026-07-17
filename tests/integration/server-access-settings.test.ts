import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import { createAppContext } from '../../backend/context.js';
import { hashAdminPassword } from '../../backend/core/password.js';
import { admins, auditLogs, serverAccessSettings } from '../../backend/db/index.js';
import { storeTlsMaterial } from '../../backend/services/server-access-settings.js';

const certificatePem = readFileSync(resolve('tests/fixtures/server-access-test.crt.pem'), 'utf8');
const privateKeyPem = readFileSync(resolve('tests/fixtures/server-access-test.key.pem'), 'utf8');
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

describe('server access settings API', () => {
  it('removes uncommitted and superseded TLS material', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-server-access-cleanup-'));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: join(directory, 'master.key'),
      PORT: '5173',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      LOG_LEVEL: 'silent',
    });
    const context = createAppContext(config);
    context.database.db.insert(admins).values({
      id: 'admin_server_access_cleanup',
      username: 'admin',
      displayName: 'Test Admin',
      passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
    }).run();
    const app = await buildApp({ context, closeContext: false, startScheduler: false });

    try {
      await app.ready();
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      const cookie = cookiesFrom(login.headers['set-cookie']);
      const csrf = (login.json() as { data: { csrf_token: string } }).data.csrf_token;
      const payload = {
        protocol: 'http' as const,
        access_host: '127.0.0.1',
        certificate_pem: certificatePem,
        private_key_pem: privateKeyPem,
      };

      context.database.sqlite.exec(`
        CREATE TRIGGER fail_server_access_insert
        BEFORE INSERT ON server_access_settings
        BEGIN
          SELECT RAISE(FAIL, 'forced transaction failure');
        END;
      `);
      const failed = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/server-access',
        headers: { cookie, 'x-csrf-token': csrf },
        payload,
      });
      expect(failed.statusCode).toBe(500);
      const materialsRoot = join(directory, 'tls', 'materials');
      expect(readdirSync(materialsRoot)).toHaveLength(0);
      context.database.sqlite.exec('DROP TRIGGER fail_server_access_insert');

      const first = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/server-access',
        headers: { cookie, 'x-csrf-token': csrf },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const firstMaterialId = context.database.db.select().from(serverAccessSettings).get()!.tlsMaterialId!;
      expect(existsSync(join(materialsRoot, firstMaterialId))).toBe(true);

      const second = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/server-access',
        headers: { cookie, 'x-csrf-token': csrf },
        payload,
      });
      expect(second.statusCode).toBe(200);
      const secondMaterialId = context.database.db.select().from(serverAccessSettings).get()!.tlsMaterialId!;
      expect(secondMaterialId).not.toBe(firstMaterialId);
      expect(existsSync(join(materialsRoot, firstMaterialId))).toBe(false);
      expect(existsSync(join(materialsRoot, secondMaterialId))).toBe(true);
    } finally {
      await app.close();
      await context.close();
    }
  });

  it('stores a validated certificate without returning its private material', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-server-access-'));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: join(directory, 'master.key'),
      HOST: '0.0.0.0',
      PORT: '5173',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      LOG_LEVEL: 'silent',
    });
    const context = createAppContext(config);
    context.database.db.insert(admins).values({
      id: 'admin_server_access',
      username: 'admin',
      displayName: 'Test Admin',
      passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
    }).run();
    const app = await buildApp({ context, closeContext: false, startScheduler: false });

    try {
      await app.ready();
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      const cookie = cookiesFrom(login.headers['set-cookie']);
      const csrf = (login.json() as { data: { csrf_token: string } }).data.csrf_token;

      const defaults = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/server-access',
        headers: { cookie },
      });
      expect(defaults.statusCode).toBe(200);
      expect(defaults.json().data).toMatchObject({
        protocol: 'http',
        active_protocol: 'http',
        access_host: '127.0.0.1',
        listen_port: 5173,
        restart_required: false,
        certificate: { configured: false },
      });

      const incomplete = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/server-access',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { protocol: 'https', access_host: '127.0.0.1', certificate_pem: certificatePem },
      });
      expect(incomplete.statusCode).toBe(400);

      const wrongHost = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/server-access',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: {
          protocol: 'https',
          access_host: '192.168.31.76',
          certificate_pem: certificatePem,
          private_key_pem: privateKeyPem,
        },
      });
      expect(wrongHost.statusCode).toBe(400);
      expect(wrongHost.json().error.code).toBe('SERVER_CERTIFICATE_HOST_MISMATCH');

      const updated = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/server-access',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: {
          protocol: 'https',
          access_host: '127.0.0.1',
          certificate_pem: certificatePem,
          private_key_pem: privateKeyPem,
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.body).not.toContain('BEGIN PRIVATE KEY');
      expect(updated.body).not.toContain('BEGIN CERTIFICATE');
      expect(updated.json().data).toMatchObject({
        protocol: 'https',
        active_protocol: 'http',
        next_url: 'https://127.0.0.1:5173',
        restart_required: true,
        restarting: false,
        certificate: { configured: true, host_matches: true },
      });

      const stored = context.database.db.select().from(serverAccessSettings).get();
      expect(stored).toMatchObject({ id: 'global', tlsEnabled: true, accessHost: '127.0.0.1' });
      expect(stored?.tlsMaterialId).toMatch(/^tls_/);
      expect(existsSync(join(directory, 'tls', 'materials', stored!.tlsMaterialId!, 'server.crt'))).toBe(true);
      expect(existsSync(join(directory, 'tls', 'materials', stored!.tlsMaterialId!, 'server.key'))).toBe(true);

      const audit = context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.action, 'server_access_settings.update')).get();
      expect(audit).toBeTruthy();
      expect(audit?.metadataJson).not.toContain('BEGIN');

      const revoked = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/server-access',
        headers: { cookie },
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
      await context.close();
    }
  });

  it('starts with built-in TLS and emits Secure __Host cookies after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-server-tls-'));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: join(directory, 'master.key'),
      PORT: '5173',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
    });
    const setup = createAppContext(config);
    const material = storeTlsMaterial(config, certificatePem, privateKeyPem, '127.0.0.1');
    setup.database.db.insert(serverAccessSettings).values({
      id: 'global',
      tlsEnabled: true,
      accessHost: '127.0.0.1',
      tlsMaterialId: material.materialId,
    }).run();
    setup.database.db.insert(admins).values({
      id: 'admin_server_tls',
      username: 'admin',
      displayName: 'Test Admin',
      passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
    }).run();
    await setup.close();

    const context = createAppContext(config);
    const app = await buildApp({ context, closeContext: false, startScheduler: false });
    try {
      await app.ready();
      expect(context.serverAccess.protocol).toBe('https');
      expect(context.serverAccess.secureCookies).toBe(true);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);
      const setCookie = Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie'].join('; ')
        : login.headers['set-cookie'] ?? '';
      expect(setCookie).toContain('__Host-relaymon_session=');
      expect(setCookie).toContain('__Host-relaymon_csrf=');
      expect(setCookie).toMatch(/Secure/i);
      expect(login.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await app.close();
      await context.close();
    }
  });
});
