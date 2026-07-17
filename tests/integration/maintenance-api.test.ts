import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import type { AppContext } from '../../backend/context.js';
import { createAppContext } from '../../backend/context.js';
import { hashAdminPassword } from '../../backend/core/password.js';
import {
  admins,
  auditLogs,
  maintenanceWindows,
  silences,
  sites,
} from '../../backend/db/index.js';

interface Fixture {
  app: FastifyInstance;
  context: AppContext;
  directory: string;
  cookie: string;
  csrf: string;
}

const fixtures: Fixture[] = [];

function cookiesFrom(headers: string | string[] | undefined): string {
  const values = Array.isArray(headers) ? headers : headers ? [headers] : [];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

async function createFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-maintenance-api-'));
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
    id: 'admin_maintenance_test',
    username: 'admin',
    displayName: 'Maintenance Test Admin',
    passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
  }).run();
  context.database.db.insert(sites).values([
    {
      id: 'site_alpha',
      adapterType: 'sub2api',
      name: '甲站',
      baseUrl: 'https://alpha.example.test/',
      tagsJson: JSON.stringify(['production', 'primary']),
    },
    {
      id: 'site_beta',
      adapterType: 'sub2api',
      name: '乙站',
      baseUrl: 'https://beta.example.test/',
      tagsJson: JSON.stringify(['staging']),
    },
  ]).run();
  const app = await buildApp({
    context,
    closeContext: false,
    startScheduler: false,
    startOutboxWorker: false,
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/session/login',
    payload: { username: 'admin', password: 'correct-horse-battery-staple' },
  });
  const fixture: Fixture = {
    app,
    context,
    directory,
    cookie: cookiesFrom(login.headers['set-cookie']),
    csrf: (login.json() as { data: { csrf_token: string } }).data.csrf_token,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    await fixture.context.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('maintenance and silence API', () => {
  it('persists maintenance reasons, edits schedules, and returns a real page', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    const first = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/maintenance-windows',
      headers,
      payload: {
        name: '甲站维护',
        schedule_type: 'manual',
        matcher: { site_ids: ['site_alpha'], tags: ['production'] },
        timezone: 'Asia/Shanghai',
        reason: '更换上游证书',
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({
      name: '甲站维护',
      reason: '更换上游证书',
      scope_label: '站点：甲站；标签：production',
    });
    expect(first.json().data.scope_label).not.toContain('site_alpha');
    const firstId = first.json().data.id as string;
    expect(fixture.context.database.db.select().from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, firstId)).get()?.reason).toBe('更换上游证书');

    const second = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/maintenance-windows',
      headers,
      payload: {
        name: '周期维护',
        schedule_type: 'cron',
        matcher: {},
        cron_expression: '0 2 * * 3',
        duration_seconds: 3600,
        timezone: 'UTC',
        reason: '每周例行升级',
      },
    });
    expect(second.statusCode).toBe(201);

    const page = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/maintenance-windows?page=1&page_size=1',
      headers: { cookie: fixture.cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toMatchObject({ page: 1, page_size: 1, total: 2 });
    expect(page.json().data.items).toHaveLength(1);

    const updated = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/maintenance-windows/${firstId}`,
      headers,
      payload: { name: '甲站证书维护', reason: '证书已到期，执行轮换' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ name: '甲站证书维护', reason: '证书已到期，执行轮换' });

    const ended = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/maintenance-windows/${firstId}`,
      headers,
      payload: { active: false, ends_at: new Date().toISOString() },
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().data.enabled).toBe(false);
    expect(fixture.context.database.db.select().from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, firstId)).get()?.deletedAt).toBeNull();

    const deleted = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/v1/maintenance-windows/${firstId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(fixture.context.database.db.select().from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, firstId)).get()).toBeUndefined();
  });

  it('creates, edits, ends, and permanently deletes scoped temporary silences', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/silences',
      headers,
      payload: {
        matcher: {
          site_ids: ['site_alpha'],
          tags: ['production'],
          event_types: ['site.network_unreachable'],
          severities: ['critical'],
        },
        reason: '运营商线路维护',
        starts_at: startsAt,
        ends_at: endsAt,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.matcher).toBe('站点：甲站；标签：production；事件：网络不可达；严重度：严重');
    expect(created.json().data.active).toBe(true);
    const silenceId = created.json().data.id as string;

    const changedEndsAt = new Date(Date.now() + 7_200_000).toISOString();
    const updated = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/silences/${silenceId}`,
      headers,
      payload: { reason: '运营商维护延长', ends_at: changedEndsAt },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ reason: '运营商维护延长', ends_at: changedEndsAt });

    const ended = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/silences/${silenceId}`,
      headers,
      payload: { active: false },
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().data.active).toBe(false);
    expect(fixture.context.database.db.select().from(silences)
      .where(eq(silences.id, silenceId)).get()?.deletedAt).toBeNull();

    const history = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/silences?page=1&page_size=10',
      headers: { cookie: fixture.cookie },
    });
    expect(history.json().data).toMatchObject({ total: 1 });
    expect(history.json().data.items[0]).toMatchObject({ id: silenceId, active: false });

    const deleted = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/v1/silences/${silenceId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(fixture.context.database.db.select().from(silences)
      .where(eq(silences.id, silenceId)).get()).toBeUndefined();

    const actions = fixture.context.database.db.select({ action: auditLogs.action }).from(auditLogs).all()
      .map(({ action }) => action);
    expect(actions).toEqual(expect.arrayContaining([
      'silence.create',
      'silence.update',
      'silence.end',
      'silence.delete',
    ]));
  });
});
