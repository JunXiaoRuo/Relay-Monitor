import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import type { AppContext } from '../context.js';
import { errorMessage } from '../core/errors.js';
import { createId } from '../core/ids.js';
import { redactString } from '../core/redaction.js';
import { UnsafeUrlError } from '../core/ssrf.js';
import { createWebhookFetchContext, webhookOutboundErrorMessage } from '../core/webhook.js';
import {
  notificationChannels,
  notificationDeliveries,
  outboxMessages,
} from '../db/index.js';
import {
  prepareWebhookRequest,
  redactWebhookSecrets,
  WebhookRequestConfigurationError,
} from './webhook-request.js';

const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_RECORDED_RESPONSE_CHARACTERS = 8_192;
const MAX_ERROR_CHARACTERS = 1_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

type OutboxRow = typeof outboxMessages.$inferSelect;
type ChannelRow = typeof notificationChannels.$inferSelect;
type ResumableOutboxState = 'pending' | 'retry';

interface ClaimedOutboxMessage {
  message: OutboxRow;
  resumeState: ResumableOutboxState;
}

export interface WebhookDeliveryResult {
  succeeded: boolean;
  retryable: boolean;
  responseStatus: number | null;
  responseBodyTruncated: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryAfterMs?: number;
}

export type OutboxDeliver = (
  message: OutboxRow,
  channel: ChannelRow,
  signal: AbortSignal,
) => Promise<WebhookDeliveryResult>;

export interface OutboxWorkerOptions {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  concurrency?: number;
  now?: () => Date;
  deliver?: OutboxDeliver;
}

export interface OutboxWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<number>;
}

function parseRetryDelays(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

function retryAfterMilliseconds(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) {
    return Math.min(Number(value.trim()) * 1_000, 7 * 24 * 60 * 60_000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.min(at - now.getTime(), 7 * 24 * 60 * 60_000));
}

function httpFailure(status: number): { retryable: boolean; code: string } {
  if (status >= 300 && status < 400) return { retryable: false, code: 'WEBHOOK_REDIRECT_BLOCKED' };
  if ([408, 409, 425, 429].includes(status) || status >= 500) {
    return { retryable: true, code: 'WEBHOOK_HTTP_RETRYABLE' };
  }
  return { retryable: false, code: 'WEBHOOK_HTTP_REJECTED' };
}

export async function deliverWebhookMessage(
  context: AppContext,
  message: OutboxRow,
  channel: ChannelRow,
  signal: AbortSignal,
): Promise<WebhookDeliveryResult> {
  if (channel.method !== 'POST') {
    return {
      succeeded: false,
      retryable: false,
      responseStatus: null,
      responseBodyTruncated: null,
      errorCode: 'WEBHOOK_METHOD_UNSUPPORTED',
      errorMessage: 'Only POST webhook channels are supported',
    };
  }
  if (Buffer.byteLength(message.payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    return {
      succeeded: false,
      retryable: false,
      responseStatus: null,
      responseBodyTruncated: null,
      errorCode: 'WEBHOOK_PAYLOAD_TOO_LARGE',
      errorMessage: 'Webhook payload exceeds the configured service limit',
    };
  }
  try {
    const parsed = JSON.parse(message.payloadJson) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).event_id !== message.eventId ||
      typeof (parsed as Record<string, unknown>).schema_version !== 'string'
    ) {
      throw new Error('Webhook payload envelope is invalid');
    }
  } catch {
    return {
      succeeded: false,
      retryable: false,
      responseStatus: null,
      responseBodyTruncated: null,
      errorCode: 'WEBHOOK_PAYLOAD_INVALID',
      errorMessage: 'Webhook 请求体必须是带版本号的 JSON 事件，且事件 ID 必须与投递记录一致',
    };
  }

  let outbound: Awaited<ReturnType<typeof createWebhookFetchContext>> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareWebhookRequest>> | undefined;
  const startedAt = new Date();
  try {
    prepared = await prepareWebhookRequest(context, channel, {
      eventId: message.eventId,
      idempotencyKey: message.idempotencyKey,
      payloadJson: message.payloadJson,
      timestamp: startedAt,
    });
    outbound = await createWebhookFetchContext(channel.url, {
      isProduction: context.config.isProduction,
      allowedCidrs: context.config.outboundAllowedCidrs,
      connectTimeoutMs: channel.timeoutSeconds * 1_000,
      maxResponseBytes: channel.maxResponseBytes,
    });
    const timeoutSignal = AbortSignal.timeout(channel.timeoutSeconds * 1_000);
    const response = await outbound.fetch(outbound.baseUrl, {
      method: 'POST',
      headers: prepared.headers,
      body: prepared.body,
      signal: AbortSignal.any([signal, timeoutSignal]),
    });
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      responseText = '[response body omitted]';
    }
    const redactedBody = redactWebhookSecrets(
      redactString(responseText),
      prepared.sensitiveValues,
    ).slice(0, MAX_RECORDED_RESPONSE_CHARACTERS) || null;
    if (response.ok) {
      return {
        succeeded: true,
        retryable: false,
        responseStatus: response.status,
        responseBodyTruncated: redactedBody,
        errorCode: null,
        errorMessage: null,
      };
    }
    const classification = httpFailure(response.status);
    const retryAfterMs = response.status === 429
      ? retryAfterMilliseconds(response.headers.get('retry-after'), startedAt)
      : undefined;
    return {
      succeeded: false,
      retryable: classification.retryable,
      responseStatus: response.status,
      responseBodyTruncated: redactedBody,
      errorCode: classification.code,
      errorMessage: `Webhook 接收端返回 HTTP ${response.status}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch (error) {
    const unsafe = error instanceof UnsafeUrlError;
    const configuration = error instanceof WebhookRequestConfigurationError;
    const stopped = signal.aborted;
    return {
      succeeded: false,
      retryable: !unsafe && !configuration,
      responseStatus: null,
      responseBodyTruncated: null,
      errorCode: unsafe
        ? 'UNSAFE_OUTBOUND_URL'
        : stopped
          ? 'OUTBOX_WORKER_STOPPED'
          : configuration
            ? error.code
            : 'WEBHOOK_REQUEST_FAILED',
      errorMessage: (unsafe
        ? webhookOutboundErrorMessage(error)
        : stopped
          ? '服务停止时中断了本次 Webhook 投递，稍后会继续处理'
          : redactWebhookSecrets(
            redactString(errorMessage(error)),
            prepared?.sensitiveValues ?? [],
          )).slice(0, MAX_ERROR_CHARACTERS),
    };
  } finally {
    prepared?.dispose();
    await outbound?.close();
  }
}

function claimDue(
  context: AppContext,
  leaseOwner: string,
  now: Date,
  leaseDurationMs: number,
  limit: number,
): ClaimedOutboxMessage[] {
  if (limit <= 0) return [];
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();
  return context.database.sqlite.transaction(() => {
    const candidates = context.database.db.select().from(outboxMessages).where(or(
      and(
        inArray(outboxMessages.state, ['pending', 'retry']),
        lte(outboxMessages.nextAttemptAt, nowIso),
      ),
      and(
        eq(outboxMessages.state, 'sending'),
        or(isNull(outboxMessages.leaseUntil), lte(outboxMessages.leaseUntil, nowIso)),
      ),
    )).orderBy(outboxMessages.nextAttemptAt).limit(limit).all();
    const claimed: ClaimedOutboxMessage[] = [];
    for (const candidate of candidates) {
      const updated = context.database.db.update(outboxMessages).set({
        state: 'sending',
        attempts: candidate.attempts + 1,
        leaseOwner,
        leaseUntil,
        updatedAt: nowIso,
      }).where(eq(outboxMessages.id, candidate.id)).returning().get();
      if (updated) {
        claimed.push({
          message: updated,
          resumeState: candidate.state === 'pending' ? 'pending' : 'retry',
        });
      }
    }
    return claimed;
  }).immediate();
}

function releaseStoppedClaim(
  context: AppContext,
  message: OutboxRow,
  leaseOwner: string,
  resumeState: ResumableOutboxState,
  releasedAt: Date,
): boolean {
  const released = context.database.db.update(outboxMessages).set({
    state: resumeState,
    attempts: Math.max(0, message.attempts - 1),
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: releasedAt.toISOString(),
  }).where(and(
    eq(outboxMessages.id, message.id),
    eq(outboxMessages.state, 'sending'),
    eq(outboxMessages.leaseOwner, leaseOwner),
    eq(outboxMessages.attempts, message.attempts),
  )).run();
  return released.changes === 1;
}

function completeAttempt(
  context: AppContext,
  message: OutboxRow,
  leaseOwner: string,
  channel: ChannelRow | undefined,
  result: WebhookDeliveryResult,
  requestTimestamp: string,
  completedAt: Date,
  durationMs: number,
): boolean {
  return context.database.sqlite.transaction(() => {
    const current = context.database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.id, message.id)).get();
    if (
      !current ||
      current.state !== 'sending' ||
      current.leaseOwner !== leaseOwner ||
      current.attempts !== message.attempts
    ) return false;

    const delays = channel ? parseRetryDelays(channel.retryDelaysJson) : [];
    const configuredDelayMs = (delays[current.attempts - 1] ?? 0) * 1_000;
    const canRetry = result.retryable && current.attempts <= delays.length;
    const retryDelayMs = result.retryAfterMs === undefined
      ? configuredDelayMs
      : result.retryAfterMs;
    const completedAtIso = completedAt.toISOString();
    const nextState = result.succeeded ? 'sent' : canRetry ? 'retry' : 'dead';
    const nextAttemptAt = canRetry
      ? new Date(completedAt.getTime() + retryDelayMs).toISOString()
      : current.nextAttemptAt;
    context.database.db.insert(notificationDeliveries).values({
      id: createId('delivery'),
      outboxMessageId: current.id,
      attemptNumber: current.attempts,
      requestTimestamp,
      responseStatus: result.responseStatus,
      durationMs,
      responseBodyTruncated: result.responseBodyTruncated,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage ? redactString(result.errorMessage).slice(0, MAX_ERROR_CHARACTERS) : null,
      succeeded: result.succeeded,
      createdAt: completedAtIso,
    }).run();
    context.database.db.update(outboxMessages).set({
      state: nextState,
      nextAttemptAt,
      leaseOwner: null,
      leaseUntil: null,
      lastErrorCode: result.succeeded ? null : result.errorCode,
      lastErrorMessage: result.succeeded ? null : result.errorMessage,
      sentAt: result.succeeded ? completedAtIso : null,
      updatedAt: completedAtIso,
    }).where(and(
      eq(outboxMessages.id, current.id),
      eq(outboxMessages.state, 'sending'),
      eq(outboxMessages.leaseOwner, leaseOwner),
    )).run();
    return true;
  }).immediate();
}

export function createOutboxWorker(
  context: AppContext,
  onError: (error: unknown, message?: OutboxRow) => void,
  options: OutboxWorkerOptions = {},
): OutboxWorker {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const now = options.now ?? (() => new Date());
  const deliver = options.deliver ?? ((message, channel, signal) =>
    deliverWebhookMessage(context, message, channel, signal));
  const leaseOwner = createId('outboxworker');
  let timer: NodeJS.Timeout | undefined;
  let currentTick: Promise<number> | undefined;
  let stopController = new AbortController();

  async function processMessage(
    message: OutboxRow,
    resumeState: ResumableOutboxState,
  ): Promise<void> {
    const startedAt = now();
    const workerSignal = stopController.signal;
    const channel = context.database.db.select().from(notificationChannels)
      .where(eq(notificationChannels.id, message.channelId)).get();
    let result: WebhookDeliveryResult;
    try {
      if (!channel) {
        result = {
          succeeded: false,
          retryable: false,
          responseStatus: null,
          responseBodyTruncated: null,
          errorCode: 'WEBHOOK_CHANNEL_MISSING',
          errorMessage: 'Notification channel no longer exists',
        };
      } else if (!channel.enabled) {
        result = {
          succeeded: false,
          retryable: false,
          responseStatus: null,
          responseBodyTruncated: null,
          errorCode: 'WEBHOOK_CHANNEL_DISABLED',
          errorMessage: 'Notification channel is disabled',
        };
      } else {
        result = await deliver(message, channel, workerSignal);
      }
      const completedAt = now();
      if (
        !result.succeeded &&
        (workerSignal.aborted || result.errorCode === 'OUTBOX_WORKER_STOPPED')
      ) {
        releaseStoppedClaim(context, message, leaseOwner, resumeState, completedAt);
        return;
      }
      completeAttempt(
        context,
        message,
        leaseOwner,
        channel,
        result,
        startedAt.toISOString(),
        completedAt,
        Math.max(0, completedAt.getTime() - startedAt.getTime()),
      );
    } catch (error) {
      const completedAt = now();
      if (workerSignal.aborted) {
        releaseStoppedClaim(context, message, leaseOwner, resumeState, completedAt);
        return;
      }
      onError(error, message);
      completeAttempt(context, message, leaseOwner, channel, {
        succeeded: false,
        retryable: true,
        responseStatus: null,
        responseBodyTruncated: null,
        errorCode: 'OUTBOX_WORKER_ERROR',
        errorMessage: redactString(errorMessage(error)).slice(0, MAX_ERROR_CHARACTERS),
      }, startedAt.toISOString(), completedAt, Math.max(0, completedAt.getTime() - startedAt.getTime()));
    }
  }

  async function executeTick(): Promise<number> {
    const claimed = claimDue(context, leaseOwner, now(), leaseDurationMs, concurrency);
    await Promise.all(claimed.map(({ message, resumeState }) => processMessage(message, resumeState)));
    return claimed.length;
  }

  function tick(): Promise<number> {
    if (currentTick) return Promise.resolve(0);
    currentTick = executeTick().finally(() => {
      currentTick = undefined;
    });
    return currentTick;
  }

  return {
    tick,
    start: async () => {
      if (timer) return;
      if (stopController.signal.aborted) stopController = new AbortController();
      timer = setInterval(() => void tick().catch((error) => onError(error)), pollIntervalMs);
      timer.unref();
      void tick().catch((error) => onError(error));
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      stopController.abort();
      await currentTick;
    },
  };
}
