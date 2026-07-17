import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import { createAppContext } from '../../backend/context.js';
import { hashAdminPassword } from '../../backend/core/password.js';
import {
  admins,
  auditLogs,
  balanceAlertSettings,
  monitorConfigs,
  monitorJobs,
  sites,
} from '../../backend/db/index.js';

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

describe('global low-balance settings API', () => {
  it('persists a normalized threshold and immediately queues enabled balance monitors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-balance-settings-'));
    temporaryDirectories.push(directory);
    const context = createAppContext(loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: directory,
      DATABASE_URL: join(directory, 'monitor.db'),
      MASTER_KEY_FILE: join(directory, 'master.key'),
      LOG_LEVEL: 'silent',
    }));
    context.database.db.insert(admins).values({
      id: 'admin_balance_settings',
      username: 'admin',
      displayName: 'Test Admin',
      passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
    }).run();
    context.database.db.insert(sites).values({
      id: 'site_balance_settings',
      adapterType: 'sub2api',
      name: 'Balance relay',
      baseUrl: 'https://relay.example.com',
    }).run();
    context.database.db.insert(monitorConfigs).values({
      id: 'monitor_config_balance_settings',
      siteId: 'site_balance_settings',
      monitorType: 'balance',
      enabled: true,
    }).run();
    context.database.db.insert(monitorJobs).values({
      id: 'monitor_job_balance_settings',
      siteId: 'site_balance_settings',
      monitorType: 'balance',
      state: 'retry',
      nextRunAt: '2099-01-01T00:00:00.000Z',
      retryAfter: '2099-01-01T00:00:00.000Z',
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
        url: '/api/v1/settings/balance-alert',
        headers: { cookie },
      });
      expect(defaults.statusCode).toBe(200);
      expect(defaults.json().data).toMatchObject({ enabled: true, threshold: '10' });

      const updated = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/balance-alert',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { enabled: true, threshold: '5.5000' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().data).toMatchObject({ enabled: true, threshold: '5.5', queued_checks: 1 });
      expect(context.database.db.select().from(balanceAlertSettings).get()).toMatchObject({
        id: 'global', enabled: true, threshold: '5.5',
      });
      expect(context.database.db.select().from(monitorJobs)
        .where(eq(monitorJobs.id, 'monitor_job_balance_settings')).get()).toMatchObject({
        state: 'queued', retryAfter: null, runRequested: false,
      });
      expect(context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.action, 'balance_alert_settings.update')).get()).toBeTruthy();
    } finally {
      await app.close();
      await context.close();
    }
  });
});
