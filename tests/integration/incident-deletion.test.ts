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
  incidents,
  notificationDeliveries,
  notificationRuleRevisions,
  notificationRules,
  outboxMessages,
} from '../../backend/db/index.js';

interface Fixture {
  app: FastifyInstance;
  context: AppContext;
  directory: string;
  cookie: string;
  csrf: string;
}

const fixtures: Fixture[] = [];
const LARGE_TIME_DELETE_GROUP_SIZE = 450;
const LARGE_DELETE_ALL_GROUP_SIZE = 32_800;

function cookiesFrom(headers: string | string[] | undefined): string {
  const values = Array.isArray(headers) ? headers : headers ? [headers] : [];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

async function createFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-incident-delete-'));
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
    id: 'admin_incident_delete',
    username: 'admin',
    displayName: 'Incident Delete Admin',
    passwordHash: await hashAdminPassword('correct-horse-battery-staple'),
  }).run();
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
  const fixture = {
    app,
    context,
    directory,
    cookie: cookiesFrom(login.headers['set-cookie']),
    csrf: (login.json() as { data: { csrf_token: string } }).data.csrf_token,
  };
  fixtures.push(fixture);
  return fixture;
}

function insertIncidents(
  fixture: Fixture,
  values: Array<typeof incidents.$inferInsert>,
): void {
  fixture.context.database.sqlite.transaction(() => {
    for (let offset = 0; offset < values.length; offset += 50) {
      fixture.context.database.db.insert(incidents).values(values.slice(offset, offset + 50)).run();
    }
  }).immediate();
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    await fixture.context.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('incident deletion API', () => {
  it('permanently deletes an incident, its dependent incidents, and delivery history', async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    fixture.context.database.sqlite.prepare(`
      insert into notification_channels (id, name, type, enabled, url, method)
      values (?, ?, 'webhook', 1, ?, 'POST')
    `).run('channel_incident_delete', 'Incident delete channel', 'https://hooks.example.test/incident');
    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_incident_delete',
      name: 'Probe failure rule',
      type: 'monitor_events',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_incident_delete',
      ruleId: 'rule_incident_delete',
      revisionNumber: 1,
      conditionJson: JSON.stringify({ event_types: ['probe.failed'] }),
      channelIdsJson: JSON.stringify(['channel_incident_delete']),
    }).run();
    fixture.context.database.db.update(notificationRules).set({
      currentRevisionId: 'revision_incident_delete',
    }).where(eq(notificationRules.id, 'rule_incident_delete')).run();
    fixture.context.database.db.insert(incidents).values({
      id: 'incident_delete_test',
      ruleRevisionId: 'revision_incident_delete',
      resourceKey: 'rate:test',
      eventType: 'probe.failed',
      fingerprint: 'incident-delete-fingerprint',
      activeFingerprint: 'incident-delete-fingerprint',
      state: 'firing',
      severity: 'warning',
      summary: 'Model probe failed',
      firstObservedAt: now,
      firedAt: now,
      lastObservedAt: now,
    }).run();
    fixture.context.database.db.insert(incidents).values({
      id: 'incident_delete_dependency',
      ruleRevisionId: 'revision_incident_delete',
      resourceKey: 'monitor:rates',
      eventType: 'site.network_unreachable',
      fingerprint: 'incident-delete-dependency',
      state: 'firing',
      severity: 'warning',
      summary: 'Dependent monitor failed',
      firstObservedAt: now,
      lastObservedAt: now,
      suppressedByIncidentId: 'incident_delete_test',
      suppressionReason: 'root_cause_dependency',
    }).run();
    fixture.context.database.db.insert(outboxMessages).values({
      id: 'outbox_incident_delete',
      incidentId: 'incident_delete_test',
      channelId: 'channel_incident_delete',
      eventId: 'event_incident_delete',
      idempotencyKey: 'event_incident_delete',
      state: 'retry',
      payloadJson: '{}',
      attempts: 1,
      nextAttemptAt: now,
    }).run();
    fixture.context.database.db.insert(notificationDeliveries).values({
      id: 'delivery_incident_delete',
      outboxMessageId: 'outbox_incident_delete',
      attemptNumber: 1,
      requestTimestamp: now,
      responseStatus: 503,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      succeeded: false,
    }).run();

    fixture.context.database.db.update(outboxMessages).set({ state: 'sending' })
      .where(eq(outboxMessages.id, 'outbox_incident_delete')).run();

    const unauthenticated = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/v1/incidents/incident_delete_test',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const missingCsrf = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/v1/incidents/incident_delete_test',
      headers: { cookie: fixture.cookie },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_delete_test')).get()?.deletedAt).toBeNull();

    const deliveryInProgress = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/v1/incidents/incident_delete_test',
      headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
    });
    expect(deliveryInProgress.statusCode, deliveryInProgress.body).toBe(409);
    expect(deliveryInProgress.json().error.code).toBe('INCIDENT_DELIVERY_IN_PROGRESS');
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_delete_test')).get()).toBeDefined();
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_delete_dependency')).get()).toBeDefined();
    expect(fixture.context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, 'outbox_incident_delete')).get()).toBeDefined();
    expect(fixture.context.database.db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, 'delivery_incident_delete')).get()).toBeDefined();
    expect(fixture.context.database.db.select().from(auditLogs)
      .where(eq(auditLogs.action, 'incident.delete')).all()).toHaveLength(0);

    fixture.context.database.db.update(outboxMessages).set({ state: 'retry' })
      .where(eq(outboxMessages.id, 'outbox_incident_delete')).run();

    const deleted = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/v1/incidents/incident_delete_test',
      headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_delete_test')).get()).toBeUndefined();
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_delete_dependency')).get()).toBeUndefined();
    expect(fixture.context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, 'outbox_incident_delete')).get()).toBeUndefined();
    expect(fixture.context.database.db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, 'delivery_incident_delete')).get()).toBeUndefined();

    const deliveries = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/notification-deliveries?incident_id=incident_delete_test&page=1&page_size=20',
      headers: { cookie: fixture.cookie },
    });
    expect(deliveries.statusCode, deliveries.body).toBe(200);
    expect(deliveries.json().data).toMatchObject({
      total: 0,
      items: [],
    });

    const list = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/incidents?page=1&page_size=20',
      headers: { cookie: fixture.cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toMatchObject({ items: [], total: 0 });

    const repeated = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/v1/incidents/incident_delete_test',
      headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
    });
    expect(repeated.statusCode).toBe(404);

    const audit = fixture.context.database.db.select().from(auditLogs)
      .where(eq(auditLogs.action, 'incident.delete')).get();
    expect(audit).toMatchObject({
      adminId: 'admin_incident_delete',
      resourceType: 'incident',
      resourceId: 'incident_delete_test',
    });
    expect(JSON.parse(audit?.metadataJson ?? '{}')).toMatchObject({
      previous_state: 'firing',
      event_type: 'probe.failed',
      deleted_incident_count: 2,
      deleted_notification_history: true,
    });
  });

  it('deletes selected incidents, incidents before a cutoff, and then all remaining incidents', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_incident_bulk_delete',
      name: 'Bulk delete rule',
      type: 'monitor_events',
      currentRevisionId: 'revision_incident_bulk_delete',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_incident_bulk_delete',
      ruleId: 'rule_incident_bulk_delete',
      revisionNumber: 1,
    }).run();
    insertIncidents(fixture, [
      {
        id: 'incident_bulk_selected',
        ruleRevisionId: 'revision_incident_bulk_delete',
        resourceKey: 'site',
        eventType: 'site.timeout',
        fingerprint: 'incident-bulk-selected',
        state: 'resolved',
        severity: 'warning',
        summary: 'Selected delete',
        firstObservedAt: '2026-07-01T00:00:00.000Z',
        lastObservedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'incident_bulk_cutoff',
        ruleRevisionId: 'revision_incident_bulk_delete',
        resourceKey: 'site',
        eventType: 'site.timeout',
        fingerprint: 'incident-bulk-cutoff',
        state: 'resolved',
        severity: 'warning',
        summary: 'Cutoff delete',
        firstObservedAt: '2026-07-02T00:00:00.000Z',
        lastObservedAt: '2026-07-02T00:00:00.000Z',
      },
      {
        id: 'incident_bulk_remaining',
        ruleRevisionId: 'revision_incident_bulk_delete',
        resourceKey: 'site',
        eventType: 'site.timeout',
        fingerprint: 'incident-bulk-remaining',
        state: 'resolved',
        severity: 'warning',
        summary: 'Delete all',
        firstObservedAt: '2026-07-03T00:00:00.000Z',
        lastObservedAt: '2026-07-03T00:00:00.000Z',
      },
      ...Array.from({ length: LARGE_TIME_DELETE_GROUP_SIZE }, (_, index) => ({
        id: `incident_bulk_old_${index}`,
        ruleRevisionId: 'revision_incident_bulk_delete',
        resourceKey: 'site',
        eventType: 'site.timeout',
        fingerprint: `incident-bulk-old-${index}`,
        state: 'resolved',
        severity: 'warning',
        summary: `Old incident ${index}`,
        firstObservedAt: '2026-07-02T00:00:00.000Z',
        lastObservedAt: '2026-07-02T00:00:00.000Z',
      })),
      ...Array.from({ length: LARGE_DELETE_ALL_GROUP_SIZE }, (_, index) => ({
        id: `incident_bulk_new_${index}`,
        ruleRevisionId: 'revision_incident_bulk_delete',
        resourceKey: 'site',
        eventType: 'site.timeout',
        fingerprint: `incident-bulk-new-${index}`,
        state: 'resolved',
        severity: 'warning',
        summary: `New incident ${index}`,
        firstObservedAt: '2026-07-03T00:00:00.000Z',
        lastObservedAt: '2026-07-03T00:00:00.000Z',
      })),
    ]);

    const selected = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/incidents/batch-delete',
      headers,
      payload: { ids: ['incident_bulk_selected'] },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json().data).toEqual({ deleted_count: 1 });

    const byTime = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/incidents/delete-by-time',
      headers,
      payload: { before: '2026-07-02T00:00:00.000Z' },
    });
    expect(byTime.statusCode, byTime.body).toBe(200);
    expect(byTime.json().data).toEqual({ deleted_count: LARGE_TIME_DELETE_GROUP_SIZE + 1 });
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_bulk_old_449')).get()).toBeUndefined();
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_bulk_remaining')).get()).toBeDefined();
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_bulk_new_449')).get()).toBeDefined();

    const all = await fixture.app.inject({ method: 'DELETE', url: '/api/v1/incidents', headers });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().data).toEqual({ deleted_count: LARGE_DELETE_ALL_GROUP_SIZE + 1 });
    expect(fixture.context.database.db.select().from(incidents).all()).toHaveLength(0);
  }, 15_000);
});
