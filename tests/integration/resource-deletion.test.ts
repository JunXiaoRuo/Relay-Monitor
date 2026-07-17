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
  maintenanceWindows,
  notificationChannels,
  notificationRuleRevisions,
  notificationRules,
  outboxMessages,
  silences,
  sites,
} from '../../backend/db/index.js';
import {
  SYSTEM_EVENT_RULE_ID,
  SYSTEM_EVENT_RULE_REVISION_ID,
} from '../../backend/services/system-event-rule.js';

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
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-delete-api-'));
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
    id: 'admin_delete_test',
    username: 'admin',
    displayName: 'Delete Test Admin',
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

async function remove(fixture: Fixture, url: string) {
  return fixture.app.inject({
    method: 'DELETE',
    url,
    headers: {
      cookie: fixture.cookie,
      'x-csrf-token': fixture.csrf,
    },
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.close();
    await fixture.context.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe('resource deletion API', () => {
  it('creates and edits notification channels and directly bound detailed rules', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    const createdChannel = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-channels',
      headers,
      payload: {
        name: 'Ops webhook',
        url: 'http://1.1.1.1/hooks/ops',
        signing_enabled: false,
      },
    });
    expect(createdChannel.statusCode, createdChannel.body).toBe(201);
    expect(createdChannel.json().data.url).toBe('http://1.1.1.1/hooks/ops');
    const channelId = createdChannel.json().data.id as string;
    const updatedChannel = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/notification-channels/${channelId}`,
      headers,
      payload: { name: 'Primary ops webhook', timeout_seconds: 15 },
    });
    expect(updatedChannel.json().data).toMatchObject({ name: 'Primary ops webhook', timeout_seconds: 15 });

    const createdRule = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-rules',
      headers,
      payload: {
        name: 'Monitor event details',
        type: 'monitor_events',
        severity: 'critical',
        channel_ids: [channelId],
      },
    });
    expect(createdRule.statusCode, createdRule.body).toBe(201);
    expect(createdRule.json().data.event_types).toEqual(expect.arrayContaining([
      'site.network_unreachable',
      'site.other_error',
      'site.recovered',
      'rate.changed',
      'balance.low',
      'probe.input_tokens_high',
    ]));
    const rejectedLegacyRule = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-rules',
      headers,
      payload: { name: 'Legacy balance purpose', type: 'balance_low', severity: 'warning' },
    });
    expect(rejectedLegacyRule.statusCode).toBe(400);
    expect(rejectedLegacyRule.json().error.code).toBe('VALIDATION_ERROR');
    expect(createdRule.json().data).not.toHaveProperty('trigger_confirm_count');
    expect(createdRule.json().data.current_revision).not.toHaveProperty('trigger_confirm_count');
    const ruleId = createdRule.json().data.id as string;
    const updatedRule = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/notification-rules/${ruleId}`,
      headers,
      payload: {
        event_types: ['site.timeout', 'site.recovered'],
        repeat_interval_seconds: 600,
        max_repeats: 2,
      },
    });
    expect(updatedRule.json().data).toMatchObject({
      event_types: ['site.timeout', 'site.recovered'],
      repeat_interval_seconds: 600,
      max_repeats: 2,
      channel_ids: [channelId],
    });
    expect(updatedRule.json().data).not.toHaveProperty('trigger_confirm_count');
    const revision = fixture.context.database.db.select().from(notificationRuleRevisions)
      .where(eq(notificationRuleRevisions.id, updatedRule.json().data.current_revision.id)).get();
    expect(revision).toMatchObject({ triggerConfirmCount: 1, confirmationDurationSeconds: null });

    const removedAcknowledge = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/incidents/legacy-incident/acknowledge',
      headers,
    });
    expect(removedAcknowledge.statusCode).toBe(404);
  });

  it('hides the system fallback rule and rejects attempts to edit or delete it', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };

    expect(fixture.context.database.db.select().from(notificationRules)
      .where(eq(notificationRules.id, SYSTEM_EVENT_RULE_ID)).get()).toMatchObject({
      currentRevisionId: SYSTEM_EVENT_RULE_REVISION_ID,
      enabled: true,
      deletedAt: null,
    });

    const listed = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/notification-rules',
      headers: { cookie: fixture.cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json().data as Array<{ id: string }>).map(({ id }) => id))
      .not.toContain(SYSTEM_EVENT_RULE_ID);

    const updated = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/notification-rules/${SYSTEM_EVENT_RULE_ID}`,
      headers,
      payload: { name: 'Must remain hidden' },
    });
    const deleted = await remove(fixture, `/api/v1/notification-rules/${SYSTEM_EVENT_RULE_ID}`);
    expect(updated.statusCode, updated.body).toBe(404);
    expect(deleted.statusCode, deleted.body).toBe(404);

    expect(fixture.context.database.db.select().from(notificationRules)
      .where(eq(notificationRules.id, SYSTEM_EVENT_RULE_ID)).get()).toMatchObject({
      currentRevisionId: SYSTEM_EVENT_RULE_REVISION_ID,
      enabled: true,
      deletedAt: null,
    });
    expect(fixture.context.database.db.select().from(notificationRuleRevisions)
      .where(eq(notificationRuleRevisions.id, SYSTEM_EVENT_RULE_REVISION_ID)).get()?.ruleId)
      .toBe(SYSTEM_EVENT_RULE_ID);
  });

  it('does not expose the retired notification route API', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    const listed = await fixture.app.inject({ method: 'GET', url: '/api/v1/notification-routes', headers });
    const created = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-routes',
      headers,
      payload: { name: 'Retired route', channel_ids: [] },
    });
    expect(listed.statusCode).toBe(404);
    expect(created.statusCode).toBe(404);
  });

  it('rejects transport-managed webhook Headers', async () => {
    const fixture = await createFixture();
    for (const headerName of ['Content-Type', 'Host', 'Cookie']) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/notification-channels',
        headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
        payload: {
          name: `Unsafe plaintext header ${headerName}`,
          url: 'https://1.1.1.1/hooks/plaintext',
          headers: { [headerName]: 'must-not-be-stored' },
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(fixture.context.database.db.select().from(notificationChannels)
      .all()).toEqual([]);
  });

  it('encrypts extra Headers, returns only masks, and supports preserving or clearing them', async () => {
    const fixture = await createFixture();
    const headers = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    const authorization = 'Bearer webhook-secret-token';
    const created = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-channels',
      headers,
      payload: {
        name: 'Header webhook',
        url: 'https://1.1.1.1/hooks/header',
        body_mode: 'custom',
        body_template: '{"summary": {{ payload.incident.summary | json }}}',
        headers: { Authorization: authorization, 'X-Tenant': 'relay-monitor' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const channelId = created.json().data.id as string;
    expect(created.json().data).toMatchObject({
      body_mode: 'custom',
      has_headers: true,
      headers: { Authorization: '[REDACTED]', 'X-Tenant': '[REDACTED]' },
    });
    expect(created.body).not.toContain('webhook-secret-token');
    expect(created.body).not.toContain('relay-monitor');

    let stored = fixture.context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, channelId)).get()!;
    expect(stored).toMatchObject({ secretType: 'headers_json' });
    expect(stored.headersJson).toBe('{"Authorization":"[REDACTED]","X-Tenant":"[REDACTED]"}');
    expect(stored.secretCiphertext?.toString('utf8')).not.toContain('webhook-secret-token');
    let plaintext = fixture.context.vault.decryptCredential(channelId, 'notification_channel_secret', {
      ciphertext: stored.secretCiphertext!, nonce: stored.secretNonce!,
      authTag: stored.secretAuthTag!, keyVersion: stored.secretKeyVersion!,
    });
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual({
      Authorization: authorization,
      'X-Tenant': 'relay-monitor',
    });
    plaintext.fill(0);
    expect(JSON.stringify(fixture.context.database.db.select().from(auditLogs).all()))
      .not.toContain('webhook-secret-token');

    const retained = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/notification-channels/${channelId}`,
      headers,
      payload: { name: 'Retained Header webhook', headers: created.json().data.headers },
    });
    expect(retained.statusCode, retained.body).toBe(200);
    stored = fixture.context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, channelId)).get()!;
    plaintext = fixture.context.vault.decryptCredential(channelId, 'notification_channel_secret', {
      ciphertext: stored.secretCiphertext!, nonce: stored.secretNonce!,
      authTag: stored.secretAuthTag!, keyVersion: stored.secretKeyVersion!,
    });
    expect(JSON.parse(plaintext.toString('utf8')).Authorization).toBe(authorization);
    plaintext.fill(0);
    const cleared = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/notification-channels/${channelId}`,
      headers,
      payload: { headers: {} },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().data).toMatchObject({
      has_headers: false,
      headers: {},
    });
    expect(fixture.context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, channelId)).get()).toMatchObject({
        secretType: null,
        secretCiphertext: null,
      });
  });

  it('keeps legacy signed channels readable but prevents incompatible body modes', async () => {
    const fixture = await createFixture();
    const encrypted = fixture.context.vault.encryptCredential(
      'channel_legacy_signed',
      'notification_channel_secret',
      'legacy-shared-secret',
    );
    fixture.context.database.db.insert(notificationChannels).values({
      id: 'channel_legacy_signed', name: 'Legacy signed', url: 'https://1.1.1.1/legacy',
      secretType: 'hmac_sha256', secretCiphertext: encrypted.ciphertext,
      secretNonce: encrypted.nonce, secretAuthTag: encrypted.authTag,
      secretKeyVersion: encrypted.keyVersion,
    }).run();
    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/v1/notification-channels/channel_legacy_signed',
      headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
      payload: { body_mode: 'form_data' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LEGACY_WEBHOOK_SECURITY_READ_ONLY');
    const listed = await fixture.app.inject({
      method: 'GET', url: '/api/v1/notification-channels/channel_legacy_signed',
      headers: { cookie: fixture.cookie },
    });
    expect(listed.json().data).toMatchObject({ body_mode: 'json', legacy_security: true });
  });

  it('rejects referenced channels, then archives and scrubs them after rule deletion', async () => {
    const fixture = await createFixture();
    const encrypted = fixture.context.vault.encryptCredential(
      'channel_delete_test',
      'notification_channel_secret',
      'sensitive-webhook-secret',
    );
    fixture.context.database.db.insert(notificationChannels).values({
      id: 'channel_delete_test',
      name: 'Delete test channel',
      url: 'https://hooks.example.test/path?token=sensitive',
      headersJson: JSON.stringify({ Authorization: 'secret' }),
      bodyTemplate: '{{sensitive}}',
      secretType: 'hmac_sha256',
      secretCiphertext: encrypted.ciphertext,
      secretNonce: encrypted.nonce,
      secretAuthTag: encrypted.authTag,
      secretKeyVersion: encrypted.keyVersion,
    }).run();
    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_delete_test',
      name: 'Delete test rule',
      type: 'monitor_events',
      currentRevisionId: 'revision_delete_test',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_delete_test',
      ruleId: 'rule_delete_test',
      revisionNumber: 1,
      channelIdsJson: JSON.stringify(['channel_delete_test']),
    }).run();

    const conflict = await remove(fixture, '/api/v1/notification-channels/channel_delete_test');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({
      code: 'NOTIFICATION_CHANNEL_IN_USE',
      details: { notification_rule_ids: ['rule_delete_test'] },
    });

    expect((await remove(fixture, '/api/v1/notification-rules/rule_delete_test')).statusCode).toBe(200);
    expect((await remove(fixture, '/api/v1/notification-channels/channel_delete_test')).statusCode).toBe(200);

    const archived = fixture.context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, 'channel_delete_test')).get();
    expect(archived).toMatchObject({
      enabled: false,
      url: 'https://deleted.invalid/',
      headersJson: '{}',
      bodyTemplate: null,
      secretType: null,
      secretCiphertext: null,
    });
    expect(archived?.deletedAt).not.toBeNull();
    const list = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/notification-channels',
      headers: { cookie: fixture.cookie },
    });
    expect(list.json().data).toEqual([]);
    const actions = fixture.context.database.db.select({ action: auditLogs.action }).from(auditLogs).all()
      .map(({ action }) => action);
    expect(actions).toContain('notification_rule.soft_delete');
    expect(actions).toContain('notification_channel.soft_delete');
  });

  it('archives rules while retaining incident and configuration history', async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    fixture.context.database.db.insert(sites).values({
      id: 'site_rule_delete',
      adapterType: 'sub2api',
      name: 'Rule delete site',
      baseUrl: 'https://relay.example.test/',
    }).run();
    fixture.context.database.db.insert(notificationChannels).values({
      id: 'channel_rule_delete',
      name: 'Rule delete channel',
      url: 'https://hooks.example.test/',
    }).run();
    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_with_history',
      name: 'Rule with history',
      type: 'site_down',
      currentRevisionId: 'revision_with_history',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_with_history',
      ruleId: 'rule_with_history',
      revisionNumber: 1,
      channelIdsJson: JSON.stringify(['channel_rule_delete']),
    }).run();
    fixture.context.database.db.insert(incidents).values({
      id: 'incident_rule_delete',
      ruleRevisionId: 'revision_with_history',
      siteId: 'site_rule_delete',
      resourceKey: 'health',
      eventType: 'site_down',
      fingerprint: 'rule-delete-fingerprint',
      activeFingerprint: 'rule-delete-fingerprint',
      state: 'firing',
      severity: 'warning',
      summary: 'Site is down',
      firstObservedAt: now,
      lastObservedAt: now,
    }).run();
    fixture.context.database.db.insert(outboxMessages).values({
      id: 'outbox_rule_delete',
      incidentId: 'incident_rule_delete',
      channelId: 'channel_rule_delete',
      eventId: 'event_rule_delete',
      idempotencyKey: 'event_rule_delete',
      payloadJson: '{}',
      state: 'pending',
      nextAttemptAt: now,
    }).run();

    expect((await remove(fixture, '/api/v1/notification-rules/rule_with_history')).statusCode).toBe(200);
    expect(fixture.context.database.db.select().from(notificationRules)
      .where(eq(notificationRules.id, 'rule_with_history')).get()).toMatchObject({
        enabled: false,
      });
    expect(fixture.context.database.db.select().from(notificationRules)
      .where(eq(notificationRules.id, 'rule_with_history')).get()?.deletedAt).not.toBeNull();
    expect(fixture.context.database.db.select().from(incidents)
      .where(eq(incidents.id, 'incident_rule_delete')).get()).toMatchObject({
        state: 'suppressed',
        activeFingerprint: null,
        suppressionReason: 'rule_deleted',
      });
    expect(fixture.context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, 'outbox_rule_delete')).get()).toMatchObject({
        state: 'dead',
        lastErrorCode: 'NOTIFICATION_RULE_DELETED',
      });

    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_without_history',
      name: 'Rule without history',
      type: 'site_down',
      currentRevisionId: 'revision_without_history',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_without_history',
      ruleId: 'rule_without_history',
      revisionNumber: 1,
    }).run();
    expect((await remove(fixture, '/api/v1/notification-rules/rule_without_history')).statusCode).toBe(200);
    expect(fixture.context.database.db.select().from(notificationRules)
      .where(eq(notificationRules.id, 'rule_without_history')).get()).toMatchObject({ enabled: false });
    expect(fixture.context.database.db.select().from(notificationRules)
      .where(eq(notificationRules.id, 'rule_without_history')).get()?.deletedAt).not.toBeNull();
    expect(fixture.context.database.db.select().from(notificationRuleRevisions)
      .where(eq(notificationRuleRevisions.id, 'revision_without_history')).get()).toBeDefined();

    const list = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/notification-rules',
      headers: { cookie: fixture.cookie },
    });
    expect(list.json().data).toEqual([]);
  });

  it('permanently deletes maintenance windows and silences while retaining site soft deletion', async () => {
    const fixture = await createFixture();
    const now = new Date();
    fixture.context.database.db.insert(maintenanceWindows).values({
      id: 'maintenance_delete_test',
      name: 'Delete maintenance',
      kind: 'manual',
      matcherJson: '{}',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
      timezone: 'Asia/Shanghai',
    }).run();
    fixture.context.database.db.insert(silences).values({
      id: 'silence_delete_test',
      matcherJson: '{}',
      reason: 'Delete silence',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60_000).toISOString(),
    }).run();
    fixture.context.database.db.insert(sites).values({
      id: 'site_delete_test',
      adapterType: 'sub2api',
      name: 'Delete site',
      baseUrl: 'https://relay.example.test/',
    }).run();

    expect((await remove(fixture, '/api/v1/maintenance-windows/maintenance_delete_test')).statusCode).toBe(200);
    expect((await remove(fixture, '/api/v1/silences/silence_delete_test')).statusCode).toBe(200);
    expect((await remove(fixture, '/api/v1/sites/site_delete_test')).statusCode).toBe(200);

    expect(fixture.context.database.db.select().from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, 'maintenance_delete_test')).get()).toBeUndefined();
    const maintenanceList = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/maintenance-windows',
      headers: { cookie: fixture.cookie },
    });
    expect(maintenanceList.json().data).toMatchObject({ items: [], total: 0 });
    expect(fixture.context.database.db.select().from(silences)
      .where(eq(silences.id, 'silence_delete_test')).get()).toBeUndefined();
    expect(fixture.context.database.db.select().from(sites)
      .where(eq(sites.id, 'site_delete_test')).get()).toMatchObject({
        enabled: false,
        authStatus: 'disabled',
      });

    const actions = fixture.context.database.db.select({ action: auditLogs.action }).from(auditLogs).all()
      .map(({ action }) => action);
    expect(actions).toEqual(expect.arrayContaining([
      'maintenance_window.delete',
      'silence.delete',
      'site.soft_delete',
    ]));
  });
});
