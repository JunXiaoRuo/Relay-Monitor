import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SESSION_COOKIE_PRODUCTION = '__Host-relaymon_session';
export const SESSION_COOKIE_DEVELOPMENT = 'relaymon_session';

export interface SessionSecrets {
  token: string;
  tokenHash: string;
  csrfToken: string;
  csrfTokenHash: string;
}

export function hashSessionSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createSessionSecrets(): SessionSecrets {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  return {
    token,
    tokenHash: hashSessionSecret(token),
    csrfToken,
    csrfTokenHash: hashSessionSecret(csrfToken),
  };
}

export function sessionSecretMatches(value: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashSessionSecret(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_PRODUCTION : SESSION_COOKIE_DEVELOPMENT;
}
