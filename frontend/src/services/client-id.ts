let fallbackSequence = 0;

function uuidV4FromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createClientId(source: Crypto | null | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === 'function') {
    try {
      return source.randomUUID();
    } catch {
      // Some embedded browsers expose randomUUID outside the contexts where it works.
    }
  }

  if (typeof source?.getRandomValues === 'function') {
    try {
      return uuidV4FromBytes(source.getRandomValues(new Uint8Array(16)));
    } catch {
      // Request and idempotency IDs are uniqueness markers, not authentication secrets.
    }
  }

  fallbackSequence = fallbackSequence >= Number.MAX_SAFE_INTEGER ? 1 : fallbackSequence + 1;
  const clock = Date.now().toString(36);
  const monotonic = typeof globalThis.performance?.now === 'function'
    ? Math.floor(globalThis.performance.now() * 1_000).toString(36)
    : '0';
  const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
  return `fallback-${clock}-${monotonic}-${fallbackSequence.toString(36)}-${random}`;
}
