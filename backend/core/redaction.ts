export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|secret|clientsecret|apikey|accesskey|accesstoken|refreshtoken|temptoken|sessiontoken|csrftoken|totpcode|turnstiletoken|credential|ciphertext|authtag|masterkey)$/;
const SENSITIVE_QUERY_KEY_PATTERN = /^(?:token|key|secret|password|authorization|access_token|refresh_token|api_key|signature)$/i;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEY_PATTERN.test(normalized) ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey')
  );
}

export function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|temp[_-]?token|session[_-]?token|csrf[_-]?token|turnstile[_-]?token|totp[_-]?code|api[_-]?key|password|secret|cookie|authorization|token)\s*[:=]\s*)([^\s,;&}\]]+)/gi,
      '$1[REDACTED]',
    );
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return redactString(rawUrl);
  }
}

export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isSensitiveKey(key)
        ? REDACTED
        : Array.isArray(value)
          ? value.map((item) => redactString(item))
          : typeof value === 'string'
            ? redactString(value)
            : value,
    ]),
  );
}

function redactInternal(value: unknown, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (depth > 20) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactUrl(value.toString());

  const existing = seen.get(value);
  if (existing !== undefined) return '[CIRCULAR]';

  if (value instanceof Error) {
    const redactedError = {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
    seen.set(value, redactedError);
    return redactedError;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(redactInternal(item, seen, depth + 1));
    return result;
  }

  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactInternal(item, seen, depth + 1);
  }
  return result;
}

export function redact<T>(value: T): unknown {
  return redactInternal(value, new WeakMap(), 0);
}

export const redactForLog = redact;
