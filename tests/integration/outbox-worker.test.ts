import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { createBuiltinAdapterRegistry } from '../../backend/adapters/index.js';
import type { AppContext } from '../../backend/context.js';
import { CredentialVault } from '../../backend/core/vault.js';
import {
  incidents,
  notificationChannels,
  notificationDeliveries,
  notificationRuleRevisions,
  notificationRules,
  openDatabase,
  outboxMessages,
} from '../../backend/db/index.js';
import {
  createOutboxWorker,
  deliverWebhookMessage,
  type OutboxDeliver,
  type WebhookDeliveryResult,
} from '../../backend/services/outbox-worker.js';
import { prepareWebhookRequest } from '../../backend/services/webhook-request.js';

const contexts: AppContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

function testContext(): AppContext {
  const database = openDatabase({ path: ':memory:' });
  const vault = new CredentialVault(1, new Map([[1, randomBytes(32)]]));
  const context: AppContext = {
    config: {
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 8080,
      timezone: 'UTC',
      dataDir: '.',
      databasePath: ':memory:',
      masterKeyFile: 'unused',
      masterKeyVersion: 1,
      logLevel: 'silent',
      trustProxy: false,
      webOrigin: 'http://127.0.0.1:5173',
      databaseBusyTimeoutMs: 5_000,
      maxConcurrentSites: 5,
      outboundAllowedCidrs: [],
      isProduction: false,
    },
    database,
    vault,
    adapters: createBuiltinAdapterRegistry(),
    startedAt: new Date().toISOString(),
    runtime: { schedulerRunning: false, schedulerLagMs: 0, lastScheduleSuccessAt: null },
    close: async () => {
      vault.destroy();
      database.close();
    },
  };
  contexts.push(context);
  return context;
}

function seedOutbox(context: AppContext, state: 'pending' | 'sending' = 'pending'): string {
  const ruleId = 'rule_01KXG000000000000000000000';
  const revisionId = 'revision_01KXG000000000000000000000';
  const incidentId = 'incident_01KXG000000000000000000000';
  const channelId = 'channel_01KXG000000000000000000000';
  const outboxId = 'outbox_01KXG000000000000000000000';
  context.database.db.insert(notificationChannels).values({
    id: channelId,
    name: 'Test channel',
    url: 'https://example.com/hook',
    retryDelaysJson: '[60]',
  }).run();
  context.database.db.insert(notificationRules).values({
    id: ruleId,
    name: 'Test rule',
    type: 'site_down',
    currentRevisionId: revisionId,
  }).run();
  context.database.db.insert(notificationRuleRevisions).values({
    id: revisionId,
    ruleId,
    revisionNumber: 1,
  }).run();
  context.database.db.insert(incidents).values({
    id: incidentId,
    ruleRevisionId: revisionId,
    resourceKey: 'site',
    eventType: 'site.down',
    fingerprint: 'fingerprint',
    activeFingerprint: 'fingerprint',
    severity: 'critical',
    summary: 'Site is down',
    firstObservedAt: '2026-07-14T00:00:00.000Z',
    lastObservedAt: '2026-07-14T00:00:00.000Z',
  }).run();
  context.database.db.insert(outboxMessages).values({
    id: outboxId,
    incidentId,
    channelId,
    eventId: 'event_01KXG000000000000000000000',
    idempotencyKey: 'event_01KXG000000000000000000000',
    state,
    payloadJson: JSON.stringify({ schema_version: '1.0', event_id: 'event_01KXG000000000000000000000' }),
    attempts: state === 'sending' ? 1 : 0,
    nextAttemptAt: '2026-07-14T00:00:00.000Z',
    leaseOwner: state === 'sending' ? 'crashed-worker' : null,
    leaseUntil: state === 'sending' ? '2026-07-14T00:00:30.000Z' : null,
  }).run();
  return outboxId;
}

function result(values: Partial<WebhookDeliveryResult>): WebhookDeliveryResult {
  return {
    succeeded: false,
    retryable: true,
    responseStatus: null,
    responseBodyTruncated: null,
    errorCode: 'TEST_FAILURE',
    errorMessage: 'Test failure',
    ...values,
  };
}

describe('leased outbox worker', () => {
  it('uses encrypted Headers and custom body formatting through the shared request builder', async () => {
    const context = testContext();
    const channelId = 'channel_shared_request_builder';
    const encrypted = context.vault.encryptCredential(
      channelId,
      'notification_channel_secret',
      JSON.stringify({ Authorization: 'Bearer shared-secret', 'X-Tenant': 'relay' }),
    );
    context.database.db.insert(notificationChannels).values({
      id: channelId,
      name: 'Shared request builder',
      url: 'https://example.com/hook',
      bodyMode: 'custom',
      bodyTemplate: '{"event": {{ payload.event | json }}, "summary": {{ payload.incident.summary | json }}}',
      headersJson: JSON.stringify({ Authorization: '[REDACTED]', 'X-Tenant': '[REDACTED]' }),
      secretType: 'headers_json',
      secretCiphertext: encrypted.ciphertext,
      secretNonce: encrypted.nonce,
      secretAuthTag: encrypted.authTag,
      secretKeyVersion: encrypted.keyVersion,
    }).run();
    const channel = context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, channelId)).get()!;
    const payloadJson = JSON.stringify({
      schema_version: '1.0', event_id: 'event_shared', event: 'site.timeout',
      incident: { summary: '请求超时' },
    });
    const prepared = await prepareWebhookRequest(context, channel, {
      eventId: 'event_shared',
      idempotencyKey: 'idempotency_shared',
      payloadJson,
      timestamp: new Date('2026-07-14T00:00:00.000Z'),
    });
    try {
      expect(prepared.headers).toMatchObject({
        Authorization: 'Bearer shared-secret',
        'X-Tenant': 'relay',
        'Content-Type': 'application/json; charset=utf-8',
        'Idempotency-Key': 'idempotency_shared',
        'X-Monitor-Event-ID': 'event_shared',
      });
      expect(JSON.parse((prepared.body as Buffer).toString('utf8'))).toEqual({
        event: 'site.timeout',
        summary: '请求超时',
      });
    } finally {
      prepared.dispose();
    }
  });

  it('retries the same outbox event and records every attempt', async () => {
    const context = testContext();
    const outboxId = seedOutbox(context);
    let clock = new Date('2026-07-14T00:01:00.000Z');
    const outcomes = [
      result({}),
      result({ succeeded: true, retryable: false, responseStatus: 204, errorCode: null, errorMessage: null }),
    ];
    const deliveredIds: string[] = [];
    const deliver: OutboxDeliver = async (message) => {
      deliveredIds.push(message.eventId);
      return outcomes.shift()!;
    };
    const worker = createOutboxWorker(context, () => undefined, {
      now: () => new Date(clock),
      deliver,
      concurrency: 1,
    });

    expect(await worker.tick()).toBe(1);
    let persisted = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    expect(persisted.state).toBe('retry');
    expect(persisted.attempts).toBe(1);
    expect(persisted.nextAttemptAt).toBe('2026-07-14T00:02:00.000Z');
    expect(await worker.tick()).toBe(0);

    clock = new Date('2026-07-14T00:02:00.000Z');
    expect(await worker.tick()).toBe(1);
    persisted = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    expect(persisted.state).toBe('sent');
    expect(persisted.attempts).toBe(2);
    expect(persisted.sentAt).toBe(clock.toISOString());
    expect(deliveredIds).toEqual([
      'event_01KXG000000000000000000000',
      'event_01KXG000000000000000000000',
    ]);
    const attempts = context.database.db.select().from(notificationDeliveries)
      .orderBy(notificationDeliveries.attemptNumber).all();
    expect(attempts.map((attempt) => [attempt.attemptNumber, attempt.succeeded]))
      .toEqual([[1, false], [2, true]]);
    expect(context.database.db.select().from(incidents).all()).toHaveLength(1);
  });

  it('recovers an expired sending lease without reusing its attempt number', async () => {
    const context = testContext();
    const outboxId = seedOutbox(context, 'sending');
    const clock = new Date('2026-07-14T00:01:00.000Z');
    const worker = createOutboxWorker(context, () => undefined, {
      now: () => new Date(clock),
      concurrency: 1,
      deliver: async () => result({
        succeeded: true,
        retryable: false,
        responseStatus: 200,
        errorCode: null,
        errorMessage: null,
      }),
    });

    expect(await worker.tick()).toBe(1);
    const persisted = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    expect(persisted.state).toBe('sent');
    expect(persisted.attempts).toBe(2);
    expect(context.database.db.select().from(notificationDeliveries).all()[0]?.attemptNumber).toBe(2);
  });

  it('releases a stopped delivery without consuming an attempt so another worker can deliver it', async () => {
    const context = testContext();
    const outboxId = seedOutbox(context);
    const clock = new Date('2026-07-14T00:01:00.000Z');
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const waitingDeliver: OutboxDeliver = async (_message, _channel, signal) => {
      markDeliveryStarted?.();
      return new Promise<WebhookDeliveryResult>((resolve) => {
        const stopped = () => resolve(result({
          errorCode: 'OUTBOX_WORKER_STOPPED',
          errorMessage: 'Worker stopped during delivery',
        }));
        if (signal.aborted) stopped();
        else signal.addEventListener('abort', stopped, { once: true });
      });
    };
    const stoppingWorker = createOutboxWorker(context, () => undefined, {
      now: () => new Date(clock),
      deliver: waitingDeliver,
      concurrency: 1,
    });

    const tick = stoppingWorker.tick();
    await deliveryStarted;
    await stoppingWorker.stop();
    expect(await tick).toBe(1);

    let persisted = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    expect(persisted).toMatchObject({
      state: 'pending',
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(context.database.db.select().from(notificationDeliveries).all()).toEqual([]);

    const nextWorker = createOutboxWorker(context, () => undefined, {
      now: () => new Date(clock),
      concurrency: 1,
      deliver: async () => result({
        succeeded: true,
        retryable: false,
        responseStatus: 204,
        errorCode: null,
        errorMessage: null,
      }),
    });
    expect(await nextWorker.tick()).toBe(1);
    persisted = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    expect(persisted).toMatchObject({ state: 'sent', attempts: 1 });
    expect(context.database.db.select().from(notificationDeliveries).all()).toHaveLength(1);
    expect(context.database.db.select().from(notificationDeliveries).all()[0]?.attemptNumber).toBe(1);
  });

  it('marks permanent failures dead without another network attempt', async () => {
    const context = testContext();
    const outboxId = seedOutbox(context);
    const worker = createOutboxWorker(context, () => undefined, {
      now: () => new Date('2026-07-14T00:01:00.000Z'),
      deliver: async () => result({
        retryable: false,
        responseStatus: 401,
        errorCode: 'WEBHOOK_HTTP_REJECTED',
        errorMessage: 'Webhook returned HTTP 401',
      }),
    });

    expect(await worker.tick()).toBe(1);
    const persisted = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    expect(persisted.state).toBe('dead');
    expect(await worker.tick()).toBe(0);
  });

  it('rejects a payload whose envelope does not match the outbox event', async () => {
    const context = testContext();
    const outboxId = seedOutbox(context);
    context.database.db.update(outboxMessages).set({
      payloadJson: JSON.stringify({ schema_version: '1.0', event_id: 'event_wrong', secret: 'must-not-leak' }),
    }).where(eq(outboxMessages.id, outboxId)).run();
    const message = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId)).get()!;
    const channel = context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, message.channelId)).get()!;

    const delivered = await deliverWebhookMessage(
      context,
      message,
      channel,
      new AbortController().signal,
    );
    expect(delivered).toMatchObject({
      succeeded: false,
      retryable: false,
      errorCode: 'WEBHOOK_PAYLOAD_INVALID',
    });
    expect(JSON.stringify(delivered)).not.toContain('must-not-leak');
  });
});
