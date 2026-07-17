import { createHmac, timingSafeEqual } from 'node:crypto';
import { Liquid } from 'liquidjs';
import { FormData as UndiciFormData } from 'undici';

import { createSafeFetchContext, type SafeFetchContext } from './safe-fetch.js';
import {
  isWebhookHttpAddressAllowed,
  type AddressResolver,
  UnsafeUrlError,
} from './ssrf.js';

export type WebhookSecret = string | Buffer | Uint8Array;
export type WebhookRawBody = string | Buffer | Uint8Array;
export type WebhookBodyMode = 'json' | 'form_data' | 'custom';
export type WebhookFetchBody = NonNullable<NonNullable<Parameters<typeof globalThis.fetch>[1]>['body']>;

const MAX_CUSTOM_TEMPLATE_CHARACTERS = 64 * 1024;
const MAX_WEBHOOK_REQUEST_BYTES = 1024 * 1024;
const liquid = new Liquid({
  root: './no-such-directory-relay-monitor',
  relativeReference: false,
  dynamicPartials: false,
  strictFilters: true,
  strictVariables: true,
});

liquid.registerFilter('json', (value: unknown) => JSON.stringify(value));

export interface WebhookRequestBody {
  body: WebhookFetchBody;
  contentType: string | null;
  signingBody: Buffer | null;
}

function checkedBodyBuffer(value: string | Buffer): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  if (body.byteLength > MAX_WEBHOOK_REQUEST_BYTES) {
    if (!Buffer.isBuffer(value)) body.fill(0);
    throw new Error('Webhook 请求体超过 1 MiB 服务上限');
  }
  return body;
}

function parsePayloadObject(payloadJson: string): Record<string, unknown> {
  const payload = JSON.parse(payloadJson) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Webhook 事件必须是 JSON 对象');
  }
  return payload as Record<string, unknown>;
}

function withWebhookCompatibilityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const incident = payload.incident;
  const summary = incident && typeof incident === 'object' && !Array.isArray(incident)
    ? (incident as Record<string, unknown>).summary
    : undefined;
  const msg = typeof payload.msg === 'string' && payload.msg.length > 0
    ? payload.msg
    : typeof summary === 'string' && summary.length > 0
      ? summary
      : typeof payload.event === 'string' && payload.event.length > 0
        ? `Relay Monitor：${payload.event}`
        : 'Relay Monitor 通知';
  return {
    ...payload,
    msg,
    monitor: payload.monitor ?? { name: 'Relay Monitor' },
    heartbeat: Object.hasOwn(payload, 'heartbeat') ? payload.heartbeat : null,
  };
}

export async function buildWebhookRequestBody(input: {
  payloadJson: string;
  mode: WebhookBodyMode;
  template?: string | null;
}): Promise<WebhookRequestBody> {
  if (Buffer.byteLength(input.payloadJson, 'utf8') > MAX_WEBHOOK_REQUEST_BYTES) {
    throw new Error('Webhook 事件超过 1 MiB 服务上限');
  }
  const payload = withWebhookCompatibilityFields(parsePayloadObject(input.payloadJson));
  const compatiblePayloadJson = JSON.stringify(payload);
  if (input.mode === 'json') {
    const body = checkedBodyBuffer(compatiblePayloadJson);
    return { body, contentType: 'application/json; charset=utf-8', signingBody: body };
  }
  if (input.mode === 'form_data') {
    checkedBodyBuffer(compatiblePayloadJson).fill(0);
    const form = new UndiciFormData();
    form.append('data', compatiblePayloadJson);
    return { body: form as unknown as WebhookFetchBody, contentType: null, signingBody: null };
  }
  const template = input.template?.trim();
  if (!template) throw new Error('自定义内容模式必须填写请求体模板');
  if (template.length > MAX_CUSTOM_TEMPLATE_CHARACTERS) {
    throw new Error('Webhook 请求体模板超过 64 KiB 服务上限');
  }
  if (/{%/.test(template)) {
    throw new Error('自定义请求体只支持输出表达式，不允许使用控制标签');
  }
  const rendered = await liquid.parseAndRender(template, { payload, msg: payload.msg });
  const body = checkedBodyBuffer(rendered);
  let contentType = 'text/plain; charset=utf-8';
  try {
    JSON.parse(rendered);
    contentType = 'application/json; charset=utf-8';
  } catch {
    // Arbitrary text is valid custom content.
  }
  return { body, contentType, signingBody: body };
}

export interface WebhookFetchOptions {
  isProduction: boolean;
  allowedCidrs: readonly string[];
  connectTimeoutMs: number;
  maxResponseBytes: number;
  resolver?: AddressResolver;
}

export async function createWebhookFetchContext(
  rawUrl: string,
  options: WebhookFetchOptions,
): Promise<SafeFetchContext> {
  const outbound = await createSafeFetchContext(rawUrl, {
    allowHttp: true,
    allowWebhookPrivateAddresses: true,
    allowedCidrs: options.allowedCidrs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  });
  if (
    options.isProduction &&
    outbound.validated.url.protocol === 'http:' &&
    !outbound.validated.addresses.every((address) =>
      isWebhookHttpAddressAllowed(address.address, options.allowedCidrs)
    )
  ) {
    await outbound.close();
    throw new UnsafeUrlError(
      'Production HTTP webhooks must resolve only to local or explicitly allowed addresses',
    );
  }
  return outbound;
}

const WEBHOOK_UNSAFE_URL_MESSAGES = new Map<string, string>([
  ['Outbound URL is too long', 'Webhook 地址过长'],
  ['Outbound URL is invalid', 'Webhook 地址格式无效'],
  ['Outbound URL must use HTTPS', '生产环境的公网 Webhook 必须使用 HTTPS'],
  ['Outbound URL must not contain credentials', 'Webhook 地址不能包含用户名或密码'],
  ['Outbound URL must not contain a fragment', 'Webhook 地址不能包含片段标识（#）'],
  ['Outbound URL must not contain a query string', 'Webhook 地址不能包含查询参数'],
  ['Outbound URL hostname is invalid', 'Webhook 主机名格式无效'],
  ['Local and special-use hostnames are blocked', 'Webhook 不能使用此本地或特殊用途主机名'],
  ['Single-label hostnames are blocked', 'Webhook 不能使用单标签主机名，请填写 IP 或完整域名'],
  ['DNS returned an invalid IP address', 'Webhook 域名解析返回了无效 IP 地址'],
  ['DNS returned an unsupported address family', 'Webhook 域名解析返回了不支持的地址类型'],
  ['Outbound hostname could not be resolved', 'Webhook 主机名无法解析'],
  ['Outbound hostname has no addresses', 'Webhook 主机名没有可用的解析地址'],
  [
    'Outbound hostname resolves to a private or special-use address',
    'Webhook 地址解析到了不允许的特殊用途地址；链路本地、云元数据、多播、保留或无效地址均被阻止',
  ],
  ['Cross-origin redirects are blocked', 'Webhook 不允许跨域重定向'],
  [
    'Production HTTP webhooks must resolve only to local or explicitly allowed addresses',
    '生产环境的公网 Webhook 必须使用 HTTPS；HTTP 仅允许 RFC1918 私网、回环或明确放行的地址',
  ],
]);

export function webhookOutboundErrorMessage(error: unknown): string {
  if (!(error instanceof UnsafeUrlError)) {
    return error instanceof Error ? error.message : 'Webhook 地址校验失败';
  }
  return WEBHOOK_UNSAFE_URL_MESSAGES.get(error.message)
    ?? 'Webhook 地址不符合出站安全策略，请检查协议、DNS 和目标地址';
}

export interface WebhookSignatureSecrets {
  current: WebhookSecret;
  previous?: WebhookSecret;
}

export interface VerifyWebhookSignatureOptions {
  now?: Date | number;
  toleranceSeconds?: number;
}

export type WebhookSignatureVerification =
  | { valid: true; keyVersion: 'current' | 'previous'; timestamp: number }
  | {
      valid: false;
      reason: 'invalid_timestamp' | 'expired' | 'invalid_signature';
    };

function rawBodyBytes(rawBody: WebhookRawBody): Buffer {
  return typeof rawBody === 'string'
    ? Buffer.from(rawBody, 'utf8')
    : Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
}

function secretBytes(secret: WebhookSecret): Buffer {
  const bytes =
    typeof secret === 'string'
      ? Buffer.from(secret, 'utf8')
      : Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
  if (bytes.length === 0) throw new Error('Webhook secret must not be empty');
  return bytes;
}

function normalizedTimestamp(timestamp: string | number): string {
  const text = String(timestamp);
  if (!/^\d+$/.test(text)) throw new Error('Webhook timestamp must be Unix seconds');
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error('Webhook timestamp must be a safe non-negative integer');
  }
  return String(seconds);
}

export function webhookSigningBytes(timestamp: string | number, rawBody: WebhookRawBody): Buffer {
  const timestampBytes = Buffer.from(`${normalizedTimestamp(timestamp)}.`, 'utf8');
  return Buffer.concat([timestampBytes, rawBodyBytes(rawBody)]);
}

export function computeWebhookDigest(
  secret: WebhookSecret,
  timestamp: string | number,
  rawBody: WebhookRawBody,
): string {
  return createHmac('sha256', secretBytes(secret))
    .update(webhookSigningBytes(timestamp, rawBody))
    .digest('hex');
}

export function signWebhook(
  secret: WebhookSecret,
  timestamp: string | number,
  rawBody: WebhookRawBody,
): string {
  return `sha256=${computeWebhookDigest(secret, timestamp, rawBody)}`;
}

function signatureBytes(signature: string): Buffer | undefined {
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  return match?.[1] ? Buffer.from(match[1], 'hex') : undefined;
}

function signatureMatches(
  signature: Buffer,
  secret: WebhookSecret,
  timestamp: number,
  rawBody: WebhookRawBody,
): boolean {
  const expected = Buffer.from(computeWebhookDigest(secret, timestamp, rawBody), 'hex');
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}

export function verifyWebhookSignature(
  signatureHeader: string,
  timestampHeader: string,
  rawBody: WebhookRawBody,
  secrets: WebhookSignatureSecrets,
  options: VerifyWebhookSignatureOptions = {},
): WebhookSignatureVerification {
  let timestamp: number;
  try {
    timestamp = Number(normalizedTimestamp(timestampHeader));
  } catch {
    return { valid: false, reason: 'invalid_timestamp' };
  }
  const nowMilliseconds =
    options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  const nowSeconds = Math.floor(nowMilliseconds / 1_000);
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new Error('toleranceSeconds must be non-negative');
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'expired' };
  }

  const supplied = signatureBytes(signatureHeader);
  if (!supplied) return { valid: false, reason: 'invalid_signature' };
  if (signatureMatches(supplied, secrets.current, timestamp, rawBody)) {
    return { valid: true, keyVersion: 'current', timestamp };
  }
  if (
    secrets.previous !== undefined &&
    signatureMatches(supplied, secrets.previous, timestamp, rawBody)
  ) {
    return { valid: true, keyVersion: 'previous', timestamp };
  }
  return { valid: false, reason: 'invalid_signature' };
}

export interface WebhookHeadersInput {
  eventId: string;
  timestamp: string | number;
  rawBody: WebhookRawBody;
  secret?: WebhookSecret;
  customHeaders?: Readonly<Record<string, string>>;
  contentType?: string | null;
}

const RESERVED_HEADERS = new Set([
  'content-type',
  'x-monitor-event-id',
  'x-monitor-timestamp',
  'x-monitor-signature',
  'idempotency-key',
]);

export function buildWebhookHeaders(input: WebhookHeadersInput): Record<string, string> {
  const timestamp = normalizedTimestamp(input.timestamp);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.customHeaders ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  const contentType = input.contentType === undefined ? 'application/json' : input.contentType;
  if (contentType !== null) headers['Content-Type'] = contentType;
  headers['X-Monitor-Event-ID'] = input.eventId;
  headers['X-Monitor-Timestamp'] = timestamp;
  headers['Idempotency-Key'] = input.eventId;
  if (input.secret !== undefined) {
    headers['X-Monitor-Signature'] = signWebhook(input.secret, timestamp, input.rawBody);
  }
  return headers;
}

export function serializeWebhookPayload(payload: unknown): Buffer {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error('Webhook payload must be JSON serializable');
  return Buffer.from(serialized, 'utf8');
}
