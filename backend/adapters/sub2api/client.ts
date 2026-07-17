import { createHash } from 'node:crypto';

import { isLosslessNumber, parse as parseLosslessJson } from 'lossless-json';
import type { z } from 'zod';

import { AdapterError, type AdapterErrorCode } from '../contracts/errors.js';
import { upstreamEnvelopeSchema, upstreamErrorSchema } from './schemas.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface Sub2ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface Sub2ApiRequestOptions<T> {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Readonly<Record<string, unknown>>;
  bearerToken?: string;
  idempotencyKey?: string;
  schema: z.ZodType<T>;
  unwrapEnvelope?: boolean;
  optionalCapability?: boolean;
  authFailureCode?: Extract<
    AdapterErrorCode,
    'AUTH_ACCESS_EXPIRED' | 'AUTH_INVALID_CREDENTIALS' | 'AUTH_REFRESH_FAILED'
  >;
}

export interface Sub2ApiResponse<T> {
  data: T;
  httpStatus: number;
  latencyMs: number;
  structureFingerprint: string;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AdapterError('UPSTREAM_UNREACHABLE', 'Base URL must use HTTP or HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function safeParseJson(text: string): unknown {
  try {
    return parseLosslessJson(text);
  } catch (cause) {
    throw new AdapterError('UPSTREAM_SCHEMA_ERROR', '目标站点返回了无效的 JSON 数据', {
      cause,
      details: { structureFingerprint: hashText('invalid-json') },
    });
  }
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 12) return 'depth-limit';
  if (value === null) return 'null';
  if (isLosslessNumber(value)) return 'number';
  if (Array.isArray(value)) {
    const shapes = value.slice(0, 50).map((item) => JSON.stringify(shapeOf(item, depth + 1)));
    return { array: [...new Set(shapes)].sort().map((shape) => JSON.parse(shape) as unknown) };
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, shapeOf(record[key], depth + 1)]),
    );
  }
  return typeof value;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function responseStructureFingerprint(value: unknown): string {
  return hashText(JSON.stringify(shapeOf(value)));
}

function errorMessageFromBody(body: unknown): string {
  const parsed = upstreamErrorSchema.safeParse(body);
  if (!parsed.success) return '';
  const nested = typeof parsed.data.error === 'object' ? parsed.data.error.message : parsed.data.error;
  return [parsed.data.reason, parsed.data.message, nested].filter(Boolean).join(' ');
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function classifyHttpError(
  status: number,
  body: unknown,
  headers: Headers,
  options: Sub2ApiRequestOptions<unknown>,
): AdapterError {
  const upstreamMessage = errorMessageFromBody(body);
  const normalized = upstreamMessage.toLowerCase();
  const details = {
    structureFingerprint: responseStructureFingerprint(body),
  };

  if (options.optionalCapability && (status === 404 || status === 405)) {
    return new AdapterError('UPSTREAM_CAPABILITY_UNSUPPORTED', '目标站点不支持此项可选功能', {
      httpStatus: status,
      details,
    });
  }
  if (normalized.includes('turnstile') || normalized.includes('captcha')) {
    return new AdapterError('AUTH_INTERACTION_REQUIRED', '目标站点要求完成人工验证', {
      httpStatus: status,
      details: { ...details, challenge: 'turnstile' },
    });
  }
  if (status === 401 || status === 403) {
    const code = options.authFailureCode ?? 'AUTH_ACCESS_EXPIRED';
    return new AdapterError(code, code === 'AUTH_INVALID_CREDENTIALS'
      ? '邮箱或密码错误，或目标站点拒绝了登录凭据'
      : '登录状态无效或已过期', {
      httpStatus: status,
      details,
    });
  }
  if (
    options.authFailureCode === 'AUTH_REFRESH_FAILED' &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  ) {
    return new AdapterError('AUTH_REFRESH_FAILED', 'Refresh Token 无效或已过期', {
      httpStatus: status,
      details,
    });
  }
  if (
    options.authFailureCode === 'AUTH_INVALID_CREDENTIALS' &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  ) {
    return new AdapterError('AUTH_INVALID_CREDENTIALS', '邮箱或密码错误，或目标站点拒绝了登录凭据', {
      httpStatus: status,
      details,
    });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
    return new AdapterError('UPSTREAM_RATE_LIMITED', '目标站点请求过于频繁，已触发限流', {
      retryable: true,
      httpStatus: status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      details,
    });
  }
  if (status >= 500) {
    return new AdapterError('UPSTREAM_SERVER_ERROR', '目标站点或其上游服务发生错误', {
      retryable: true,
      httpStatus: status,
      details,
    });
  }
  return new AdapterError('UPSTREAM_SCHEMA_ERROR', `目标站点返回了未预期的 HTTP 状态 ${status}`, {
    httpStatus: status,
    details,
  });
}

function unwrapEnvelope(value: unknown): unknown {
  const envelope = upstreamEnvelopeSchema.safeParse(value);
  if (!envelope.success) return value;
  if (Object.hasOwn(envelope.data, 'data')) return envelope.data.data;
  if (Object.hasOwn(envelope.data, 'result')) return envelope.data.result;
  return value;
}

export class Sub2ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #signal: AbortSignal | undefined;

  constructor(options: Sub2ApiClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#signal = options.signal;
  }

  async request<T>(path: string, options: Sub2ApiRequestOptions<T>): Promise<Sub2ApiResponse<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(this.#signal?.reason);
    this.#signal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Request timed out'));
    }, this.#timeoutMs);

    const headers = new Headers({ Accept: 'application/json' });
    if (options.body) headers.set('Content-Type', 'application/json');
    if (options.bearerToken) headers.set('Authorization', `Bearer ${options.bearerToken}`);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    };
    if (options.body) init.body = JSON.stringify(options.body);

    const startedAt = performance.now();
    try {
      const response = await this.#fetch(new URL(path, `${this.#baseUrl}/`), init);
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.#maxResponseBytes) {
        throw new AdapterError('UPSTREAM_SCHEMA_ERROR', '目标站点响应内容过大');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > this.#maxResponseBytes) {
        throw new AdapterError('UPSTREAM_SCHEMA_ERROR', '目标站点响应内容过大');
      }

      if (response.status >= 300 && response.status < 400) {
        throw new AdapterError('UPSTREAM_UNREACHABLE', '目标站点返回了不允许自动跟随的重定向', {
          httpStatus: response.status,
          details: { redirected: true },
        });
      }
      let parsed: unknown = null;
      if (text.trim() !== '') {
        try {
          parsed = safeParseJson(text);
        } catch (error) {
          if (response.ok) throw error;
        }
      }
      if (!response.ok) {
        throw classifyHttpError(response.status, parsed, response.headers, options);
      }

      const unwrapped = options.unwrapEnvelope === false ? parsed : unwrapEnvelope(parsed);
      const validated = options.schema.safeParse(unwrapped);
      if (!validated.success) {
        throw new AdapterError('UPSTREAM_SCHEMA_ERROR', '目标站点响应格式与当前适配器不兼容', {
          details: {
            structureFingerprint: responseStructureFingerprint(parsed),
            issuePaths: validated.error.issues.map((issue) => issue.path.join('.')).slice(0, 20),
          },
        });
      }
      return {
        data: validated.data,
        httpStatus: response.status,
        latencyMs,
        structureFingerprint: responseStructureFingerprint(parsed),
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError('UPSTREAM_UNREACHABLE', timedOut ? '连接目标站点超时' : '无法连接目标站点', {
        cause: error,
        retryable: true,
        details: { reason: timedOut ? 'timeout' : 'network' },
      });
    } finally {
      clearTimeout(timeout);
      this.#signal?.removeEventListener('abort', abortFromParent);
    }
  }
}
