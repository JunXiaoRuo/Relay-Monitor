import type { AppContext } from '../context.js';
import {
  buildWebhookHeaders,
  buildWebhookRequestBody,
  type WebhookBodyMode,
  type WebhookFetchBody,
} from '../core/webhook.js';
import { notificationChannels } from '../db/schema.js';

export const ENCRYPTED_HEADERS_SECRET_TYPE = 'headers_json';
export const MASKED_WEBHOOK_HEADER_VALUE = '[REDACTED]';

const CHANNEL_SECRET_AAD_TYPE = 'notification_channel_secret';

type ChannelRow = typeof notificationChannels.$inferSelect;

export class WebhookRequestConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WebhookRequestConfigurationError';
  }
}

function parseStringRecord(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookRequestConfigurationError('WEBHOOK_HEADERS_INVALID', 'Webhook Header 配置必须是 JSON 对象');
  }
  const entries = Object.entries(parsed);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    throw new WebhookRequestConfigurationError('WEBHOOK_HEADERS_INVALID', 'Webhook Header 的每个值都必须是字符串');
  }
  return Object.fromEntries(entries);
}

function secretEnvelope(channel: ChannelRow) {
  if (
    channel.secretCiphertext === null ||
    channel.secretNonce === null ||
    channel.secretAuthTag === null ||
    channel.secretKeyVersion === null
  ) return undefined;
  return {
    ciphertext: channel.secretCiphertext,
    nonce: channel.secretNonce,
    authTag: channel.secretAuthTag,
    keyVersion: channel.secretKeyVersion,
  };
}

function bodyMode(channel: ChannelRow): WebhookBodyMode {
  if (channel.bodyMode === 'json' || channel.bodyMode === 'form_data' || channel.bodyMode === 'custom') {
    return channel.bodyMode;
  }
  throw new WebhookRequestConfigurationError('WEBHOOK_BODY_MODE_INVALID', 'Webhook 请求体模式无效');
}

function legacySecretParts(value: string | null): string[] {
  if (!value || value === ENCRYPTED_HEADERS_SECRET_TYPE) return [];
  return value.split('+').map((part) => part.trim()).filter(Boolean);
}

export interface PreparedWebhookRequest {
  body: WebhookFetchBody;
  headers: Record<string, string>;
  sensitiveValues: readonly string[];
  dispose(): void;
}

export async function prepareWebhookRequest(
  context: AppContext,
  channel: ChannelRow,
  input: {
    eventId: string;
    idempotencyKey: string;
    payloadJson: string;
    timestamp?: Date;
  },
): Promise<PreparedWebhookRequest> {
  const envelope = secretEnvelope(channel);
  let decrypted: Buffer | undefined;
  let requestBody: Awaited<ReturnType<typeof buildWebhookRequestBody>> | undefined;
  try {
    decrypted = envelope
      ? context.vault.decryptCredential(channel.id, CHANNEL_SECRET_AAD_TYPE, envelope)
      : undefined;
    const customHeaders: Record<string, string> = {};
    const sensitiveValues: string[] = [];
    let hmacSecret: Buffer | undefined;

    if (channel.secretType === ENCRYPTED_HEADERS_SECRET_TYPE) {
      if (!decrypted) {
        throw new WebhookRequestConfigurationError('WEBHOOK_HEADERS_MISSING', 'Webhook 加密 Header 不可用');
      }
      const encryptedHeaders = parseStringRecord(decrypted.toString('utf8'));
      Object.assign(customHeaders, encryptedHeaders);
      sensitiveValues.push(...Object.values(encryptedHeaders).filter(Boolean));
    } else {
      const parts = legacySecretParts(channel.secretType);
      if (parts.length > 0 && !decrypted) {
        throw new WebhookRequestConfigurationError(
          'WEBHOOK_SECRET_MISSING',
          '旧版 Webhook 认证缺少加密密钥',
        );
      }
      const authentication = parts.find((part) => part !== 'hmac_sha256');
      if (decrypted && authentication === 'bearer') {
        const secret = decrypted.toString('utf8');
        customHeaders.Authorization = `Bearer ${secret}`;
        sensitiveValues.push(secret, customHeaders.Authorization);
      } else if (decrypted && authentication?.startsWith('header:')) {
        const headerName = authentication.slice('header:'.length);
        if (!headerName || /[\r\n:]/.test(headerName)) {
          throw new WebhookRequestConfigurationError(
            'WEBHOOK_SECRET_TYPE_INVALID',
            '旧版 Webhook 认证 Header 配置无效',
          );
        }
        const secret = decrypted.toString('utf8');
        customHeaders[headerName] = secret;
        sensitiveValues.push(secret);
      }
      if (decrypted && parts.includes('hmac_sha256')) hmacSecret = decrypted;
    }

    requestBody = await buildWebhookRequestBody({
      payloadJson: input.payloadJson,
      mode: bodyMode(channel),
      template: channel.bodyTemplate,
    });
    if (hmacSecret && requestBody.signingBody === null) {
      throw new WebhookRequestConfigurationError(
        'LEGACY_WEBHOOK_BODY_UNSUPPORTED',
        '旧版签名渠道只支持 JSON 请求体',
      );
    }
    const timestamp = Math.floor((input.timestamp ?? new Date()).getTime() / 1_000);
    const headers = buildWebhookHeaders({
      eventId: input.eventId,
      timestamp,
      rawBody: requestBody.signingBody ?? input.payloadJson,
      customHeaders,
      contentType: requestBody.contentType,
      ...(hmacSecret ? { secret: hmacSecret } : {}),
    });
    headers['Idempotency-Key'] = input.idempotencyKey;

    return {
      body: requestBody.body,
      headers,
      sensitiveValues,
      dispose: () => {
        if (Buffer.isBuffer(requestBody?.body)) requestBody.body.fill(0);
        decrypted?.fill(0);
      },
    };
  } catch (error) {
    if (Buffer.isBuffer(requestBody?.body)) requestBody.body.fill(0);
    decrypted?.fill(0);
    if (error instanceof WebhookRequestConfigurationError) throw error;
    throw new WebhookRequestConfigurationError(
      'WEBHOOK_REQUEST_CONFIGURATION_INVALID',
      error instanceof Error ? error.message : 'Webhook 请求配置无效',
    );
  }
}

export function redactWebhookSecrets(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) redacted = redacted.split(sensitive).join('[REDACTED]');
  }
  return redacted;
}
