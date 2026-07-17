import { argon2id, hash, verify } from 'argon2';

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_BYTES = 1_024;

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});

export function normalizeAdminUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(normalized)) {
    throw new TypeError('Username must be 3-64 characters and use lowercase letters, numbers, ., _ or -');
  }
  return normalized;
}

export function assertValidAdminPassword(password: string): void {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new TypeError(`Password must contain at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`);
  }
  if (Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_BYTES) {
    throw new TypeError(`Password must not exceed ${ADMIN_PASSWORD_MAX_BYTES} UTF-8 bytes`);
  }
  if (/\0/.test(password)) throw new TypeError('Password must not contain NUL characters');
}

export async function hashAdminPassword(password: string): Promise<string> {
  assertValidAdminPassword(password);
  return hash(password, ARGON2ID_OPTIONS);
}

export async function verifyAdminPassword(passwordHash: string, password: string): Promise<boolean> {
  if (typeof passwordHash !== 'string' || !passwordHash.startsWith('$argon2id$')) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function adminPasswordNeedsRehash(passwordHash: string): boolean {
  const parameters = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(passwordHash);
  if (!passwordHash.startsWith('$argon2id$') || !parameters) return true;
  const memory = Number(parameters[1]);
  const iterations = Number(parameters[2]);
  const parallelism = Number(parameters[3]);
  return (
    memory < ARGON2ID_OPTIONS.memoryCost ||
    iterations < ARGON2ID_OPTIONS.timeCost ||
    parallelism < ARGON2ID_OPTIONS.parallelism
  );
}
