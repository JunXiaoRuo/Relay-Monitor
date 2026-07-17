import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import { createAppContext } from '../../backend/context.js';
import { createId } from '../../backend/core/ids.js';
import { hashAdminPassword } from '../../backend/core/password.js';
import { admins, auditLogs } from '../../backend/db/index.js';

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

describe('audit log API', () => {
  it('searches and paginates in SQL and permanently deletes selected, timed, and all records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-audit-api-'));
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
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/session/login',
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      const cookie = cookiesFrom(login.headers['set-cookie']);
      const csrf = (login.json() as { data: { csrf_token: string } }).data.csrf_token;
      const authHeaders = { cookie, 'x-csrf-token': csrf };

      context.database.db.insert(auditLogs).values([
        {
          id: 'audit_search_success',
          adminId,
          action: 'site.update',
          resourceType: 'audit_test',
          resourceId: 'harbor-needle-one',
          requestId: 'req_harbor_one',
          metadataJson: JSON.stringify({ label: 'Harbor API' }),
          createdAt: '2026-07-01T10:00:00.000Z',
        },
        {
          id: 'audit_search_failed',
          adminId,
          action: 'notification.test_failed',
          resourceType: 'audit_test',
          resourceId: 'harbor-needle-two',
          requestId: 'req_harbor_two',
          metadataJson: '{}',
          createdAt: '2026-07-01T10:30:00.000Z',
        },
        {
          id: 'audit_search_other',
          adminId,
          action: 'site.update',
          resourceType: 'audit_test',
          resourceId: 'different-site',
          requestId: 'req_other',
          metadataJson: '{}',
          createdAt: '2026-07-01T11:00:00.000Z',
        },
      ]).run();

      const firstPage = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?search=harbor-needle&page=1&page_size=1',
        headers: { cookie },
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().data).toMatchObject({ page: 1, page_size: 1, total: 2 });
      expect(firstPage.json().data.items).toHaveLength(1);

      const secondPage = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?search=harbor-needle&page=2&page_size=1',
        headers: { cookie },
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().data).toMatchObject({ page: 2, page_size: 1, total: 2 });
      expect(secondPage.json().data.items[0].id).not.toBe(firstPage.json().data.items[0].id);

      const exactBoundary = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?result=failed&from=2026-07-01T10:30:00.000Z&to=2026-07-01T10:30:00.000Z',
        headers: { cookie },
      });
      expect(exactBoundary.statusCode).toBe(200);
      expect(exactBoundary.json().data.total).toBe(1);
      expect(exactBoundary.json().data.items[0].id).toBe('audit_search_failed');
      expect(exactBoundary.json().data.items[0].result).toBe('failed');

      const invalidTimestamp = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?from=2026-07-01',
        headers: { cookie },
      });
      expect(invalidTimestamp.statusCode).toBe(400);
      expect(invalidTimestamp.json().error.code).toBe('VALIDATION_ERROR');

      const invalidRange = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?from=2026-07-02T00:00:00.000Z&to=2026-07-01T00:00:00.000Z',
        headers: { cookie },
      });
      expect(invalidRange.statusCode).toBe(400);
      expect(invalidRange.json().error.code).toBe('INVALID_TIME_RANGE');

      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/v1/audit-logs/audit_search_success',
        headers: authHeaders,
      });
      expect(deleted.statusCode).toBe(200);
      expect(context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.id, 'audit_search_success')).get()).toBeUndefined();

      const remaining = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?search=harbor-needle',
        headers: { cookie },
      });
      expect(remaining.json().data.total).toBe(1);
      expect(remaining.json().data.items[0].id).toBe('audit_search_failed');

      expect(context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.action, 'audit.delete')).get()).toBeUndefined();

      const repeated = await app.inject({
        method: 'DELETE',
        url: '/api/v1/audit-logs/audit_search_success',
        headers: authHeaders,
      });
      expect(repeated.statusCode).toBe(404);
      expect(repeated.json().error.code).toBe('AUDIT_LOG_NOT_FOUND');

      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/api/v1/audit-logs/batch-delete',
        payload: { ids: ['audit_search_failed'] },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const withoutCsrf = await app.inject({
        method: 'POST',
        url: '/api/v1/audit-logs/batch-delete',
        headers: { cookie },
        payload: { ids: ['audit_search_failed'] },
      });
      expect(withoutCsrf.statusCode).toBe(403);
      expect(withoutCsrf.json().error.code).toBe('CSRF_TOKEN_INVALID');

      for (const ids of [
        [],
        ['audit_search_failed', 'audit_search_failed'],
        Array.from({ length: 101 }, (_, index) => `audit_batch_${index}`),
      ]) {
        const invalidBatch = await app.inject({
          method: 'POST',
          url: '/api/v1/audit-logs/batch-delete',
          headers: authHeaders,
          payload: { ids },
        });
        expect(invalidBatch.statusCode).toBe(400);
        expect(invalidBatch.json().error.code).toBe('VALIDATION_ERROR');
      }

      const partialConflict = await app.inject({
        method: 'POST',
        url: '/api/v1/audit-logs/batch-delete',
        headers: authHeaders,
        payload: { ids: ['audit_search_failed', 'audit_missing'] },
      });
      expect(partialConflict.statusCode).toBe(409);
      expect(partialConflict.json().error.code).toBe('AUDIT_LOG_BATCH_CONFLICT');
      expect(context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.id, 'audit_search_failed')).get()).toBeDefined();

      const batchDeleted = await app.inject({
        method: 'POST',
        url: '/api/v1/audit-logs/batch-delete',
        headers: authHeaders,
        payload: { ids: ['audit_search_failed', 'audit_search_other'] },
      });
      expect(batchDeleted.statusCode).toBe(200);
      expect(batchDeleted.json().data).toEqual({ deleted_count: 2 });

      expect(context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.id, 'audit_search_failed')).get()).toBeUndefined();
      expect(context.database.db.select().from(auditLogs)
        .where(eq(auditLogs.id, 'audit_search_other')).get()).toBeUndefined();

      context.database.db.insert(auditLogs).values([
        { id: 'audit_time_old', action: 'test.old', resourceType: 'test', createdAt: '2026-07-01T00:00:00.000Z' },
        { id: 'audit_time_new', action: 'test.new', resourceType: 'test', createdAt: '2026-07-03T00:00:00.000Z' },
      ]).run();
      const byTime = await app.inject({ method: 'POST', url: '/api/v1/audit-logs/delete-by-time', headers: authHeaders, payload: { before: '2026-07-02T00:00:00.000Z' } });
      expect(byTime.statusCode).toBe(200);
      expect(byTime.json().data.deleted_count).toBe(1);
      expect(context.database.db.select().from(auditLogs).where(eq(auditLogs.id, 'audit_time_new')).get()).toBeDefined();

      const allDeleted = await app.inject({ method: 'DELETE', url: '/api/v1/audit-logs', headers: authHeaders });
      expect(allDeleted.statusCode).toBe(200);
      expect(context.database.db.select().from(auditLogs).all()).toHaveLength(0);
    } finally {
      await app.close();
      await context.close();
    }
  });
});
