import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../backend/app.js';
import { loadConfig } from '../../backend/config.js';
import type { AppContext } from '../../backend/context.js';
import { createAppContext } from '../../backend/context.js';
import { hashAdminPassword } from '../../backend/core/password.js';
import {
  admins,
  incidents,
  notificationChannels,
  notificationRuleRevisions,
  notificationRules,
  outboxMessages,
} from '../../backend/db/index.js';
import { deliverWebhookMessage } from '../../backend/services/outbox-worker.js';

interface CapturedRequest {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function cookiesFrom(headers: string | string[] | undefined): string {
  const values = Array.isArray(headers) ? headers : headers ? [headers] : [];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

async function startReceiver(): Promise<{
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function createFixture(outboundAllowedCidrs = ''): Promise<{
  context: AppContext;
  app: Awaited<ReturnType<typeof buildApp>>;
  directory: string;
  cookie: string;
  csrf: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-webhook-'));
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATA_DIR: directory,
    DATABASE_URL: join(directory, 'monitor.db'),
    MASTER_KEY_FILE: join(directory, 'master.key'),
    LOG_LEVEL: 'silent',
    OUTBOUND_ALLOWED_CIDRS: outboundAllowedCidrs,
  });
  const context = createAppContext(config);
  context.database.db.insert(admins).values({
    id: 'admin_webhook_test',
    username: 'admin',
    displayName: 'Webhook Test Admin',
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
    context,
    app,
    directory,
    cookie: cookiesFrom(login.headers['set-cookie']),
    csrf: (login.json() as { data: { csrf_token: string } }).data.csrf_token,
  };
  cleanups.push(async () => {
    await app.close();
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

describe('webhook channel request formats', () => {
  it('uses the same encrypted Header and body formatting for channel tests and worker delivery', async () => {
    const receiver = await startReceiver();
    cleanups.push(receiver.close);
    const fixture = await createFixture();
    const authHeaders = { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf };
    const created = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-channels',
      headers: authHeaders,
      payload: {
        name: 'Local receiver',
        url: receiver.url,
        body_mode: 'form_data',
        headers: { Authorization: 'Bearer receiver-secret' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const channelId = created.json().data.id as string;

    const testResult = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/notification-channels/${channelId}/test`,
      headers: authHeaders,
    });
    expect(testResult.json().data).toMatchObject({ succeeded: true, response_status: 204 });
    expect(receiver.requests).toHaveLength(1);
    const formRequest = receiver.requests[0]!;
    expect(formRequest.headers.authorization).toBe('Bearer receiver-secret');
    expect(formRequest.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const multipartBody = formRequest.body.toString('utf8');
    expect(multipartBody).toContain('name="data"');
    expect(multipartBody).toContain('webhook.test');
    expect(multipartBody).toContain('"msg":"Webhook 测试消息"');
    expect(multipartBody).toContain('"monitor":{"name":"Relay Monitor"}');
    expect(multipartBody).toContain('"heartbeat":null');

    const updated = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/v1/notification-channels/${channelId}`,
      headers: authHeaders,
      payload: {
        body_mode: 'custom',
        body_template: '{"event": {{ payload.event | json }}, "summary": {{ payload.incident.summary | json }}}',
        headers: created.json().data.headers,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const now = new Date().toISOString();
    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_webhook_delivery', name: 'Webhook delivery', type: 'site_down',
      currentRevisionId: 'revision_webhook_delivery',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_webhook_delivery', ruleId: 'rule_webhook_delivery', revisionNumber: 1,
    }).run();
    fixture.context.database.db.insert(incidents).values({
      id: 'incident_webhook_delivery', ruleRevisionId: 'revision_webhook_delivery',
      resourceKey: 'site', eventType: 'site.timeout', fingerprint: 'webhook-delivery',
      activeFingerprint: 'webhook-delivery', state: 'firing', severity: 'warning',
      summary: 'Worker 请求超时', firstObservedAt: now, lastObservedAt: now,
    }).run();
    const payloadJson = JSON.stringify({
      schema_version: '1.0', event_id: 'event_webhook_delivery', event: 'site.timeout',
      incident: { summary: 'Worker 请求超时' },
    });
    fixture.context.database.db.insert(outboxMessages).values({
      id: 'outbox_webhook_delivery', incidentId: 'incident_webhook_delivery',
      channelId, eventId: 'event_webhook_delivery', idempotencyKey: 'event_webhook_delivery',
      payloadJson, nextAttemptAt: now,
    }).run();
    const message = fixture.context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, 'outbox_webhook_delivery')).get()!;
    const channel = fixture.context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, channelId)).get()!;
    const delivered = await deliverWebhookMessage(
      fixture.context,
      message,
      channel,
      new AbortController().signal,
    );
    expect(delivered).toMatchObject({ succeeded: true, responseStatus: 204 });
    expect(receiver.requests).toHaveLength(2);
    const workerRequest = receiver.requests[1]!;
    expect(workerRequest.headers.authorization).toBe('Bearer receiver-secret');
    expect(workerRequest.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(workerRequest.body.toString('utf8'))).toEqual({
      event: 'site.timeout', summary: 'Worker 请求超时',
    });
  });

  it('returns a Chinese error when adding a blocked special-use Webhook address', async () => {
    const fixture = await createFixture();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-channels',
      headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
      payload: {
        name: 'Cloud metadata must stay blocked',
        url: 'http://169.254.169.254/latest/meta-data',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'UNSAFE_OUTBOUND_URL',
    });
    expect(response.json().error.message).toContain('不允许的特殊用途地址');
    expect(response.json().error.message).not.toContain('Outbound hostname resolves');
  });

  it('does not let a hidden legacy channel CIDR enable a link-local metadata address', async () => {
    const fixture = await createFixture('');
    const now = new Date().toISOString();

    fixture.context.database.db.insert(notificationChannels).values({
      id: 'channel_legacy_cidr',
      name: 'Legacy metadata receiver',
      url: 'http://169.254.169.254/latest/meta-data',
      allowedCidrsJson: JSON.stringify(['169.254.0.0/16']),
    }).run();
    fixture.context.database.db.insert(notificationRules).values({
      id: 'rule_legacy_cidr', name: 'Legacy CIDR rule', type: 'site_down',
      currentRevisionId: 'revision_legacy_cidr',
    }).run();
    fixture.context.database.db.insert(notificationRuleRevisions).values({
      id: 'revision_legacy_cidr', ruleId: 'rule_legacy_cidr', revisionNumber: 1,
    }).run();
    fixture.context.database.db.insert(incidents).values({
      id: 'incident_legacy_cidr', ruleRevisionId: 'revision_legacy_cidr',
      resourceKey: 'site', eventType: 'site.network_unreachable', fingerprint: 'legacy-cidr',
      activeFingerprint: 'legacy-cidr', state: 'firing', severity: 'warning',
      summary: 'Legacy CIDR must not grant access', firstObservedAt: now, lastObservedAt: now,
    }).run();
    const payloadJson = JSON.stringify({
      schema_version: '1.0', event_id: 'event_legacy_cidr', event: 'site.network_unreachable',
      incident: { summary: 'Legacy CIDR must not grant access' },
    });
    fixture.context.database.db.insert(outboxMessages).values({
      id: 'outbox_legacy_cidr', incidentId: 'incident_legacy_cidr',
      channelId: 'channel_legacy_cidr', eventId: 'event_legacy_cidr',
      idempotencyKey: 'event_legacy_cidr', payloadJson, nextAttemptAt: now,
    }).run();

    const tested = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/notification-channels/channel_legacy_cidr/test',
      headers: { cookie: fixture.cookie, 'x-csrf-token': fixture.csrf },
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().data).toMatchObject({
      succeeded: false,
      error_code: 'UNSAFE_OUTBOUND_URL',
    });
    expect(tested.json().data.error_message).toContain('不允许的特殊用途地址');
    expect(tested.json().data.error_message).not.toContain('Outbound hostname resolves');

    const message = fixture.context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, 'outbox_legacy_cidr')).get()!;
    const channel = fixture.context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, 'channel_legacy_cidr')).get()!;
    const delivered = await deliverWebhookMessage(
      fixture.context,
      message,
      channel,
      new AbortController().signal,
    );

    expect(delivered).toMatchObject({
      succeeded: false,
      retryable: false,
      errorCode: 'UNSAFE_OUTBOUND_URL',
    });
    expect(delivered.errorMessage).toContain('不允许的特殊用途地址');
    expect(delivered.errorMessage).not.toContain('Outbound hostname resolves');
  });
});
