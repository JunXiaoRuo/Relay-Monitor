import { randomBytes } from 'node:crypto';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PATTERN = /^([a-z][a-z0-9]{1,15})_([0-9A-HJKMNP-TV-Z]{26})$/;

function encodeTimestamp(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new RangeError('ID timestamp must fit in 48 bits');
  }

  let remaining = timestamp;
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD_BASE32[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandomness(bytes: Buffer): string {
  if (bytes.length !== 10) throw new RangeError('ULID randomness must contain 10 bytes');

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let encoded = '';
  for (let index = 0; index < 16; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function createId(prefix: string, timestamp = Date.now()): string {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(prefix)) {
    throw new TypeError('ID prefix must be 2-16 lowercase alphanumeric characters');
  }
  return `${prefix}_${encodeTimestamp(timestamp)}${encodeRandomness(randomBytes(10))}`;
}

export const newId = createId;

export function isId(value: unknown, expectedPrefix?: string): value is string {
  if (typeof value !== 'string') return false;
  const match = ID_PATTERN.exec(value);
  return match !== null && (expectedPrefix === undefined || match[1] === expectedPrefix);
}

export function parseId(value: string): { prefix: string; timestamp: number } {
  const match = ID_PATTERN.exec(value);
  if (!match?.[1] || !match[2]) throw new TypeError('Invalid Relay Monitor ID');

  let timestamp = 0;
  for (const character of match[2].slice(0, 10)) {
    timestamp = timestamp * 32 + CROCKFORD_BASE32.indexOf(character);
  }
  return { prefix: match[1], timestamp };
}
