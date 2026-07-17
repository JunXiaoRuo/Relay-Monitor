import { describe, expect, it } from 'vitest';

import {
  createSessionSecrets,
  hashSessionSecret,
  sessionCookieName,
  sessionSecretMatches,
} from '../../backend/core/session-security.js';

describe('session security', () => {
  it('creates separate random session and csrf secrets', () => {
    const first = createSessionSecrets();
    const second = createSessionSecrets();

    expect(first.token).not.toBe(first.csrfToken);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toBe(hashSessionSecret(first.token));
    expect(first.csrfTokenHash).toBe(hashSessionSecret(first.csrfToken));
  });

  it('compares a presented secret against only its digest', () => {
    const secret = 'not-stored-in-the-database';
    const digest = hashSessionSecret(secret);

    expect(sessionSecretMatches(secret, digest)).toBe(true);
    expect(sessionSecretMatches(`${secret}-wrong`, digest)).toBe(false);
    expect(sessionSecretMatches(secret, 'invalid')).toBe(false);
  });

  it('uses a __Host cookie only when secure production semantics apply', () => {
    expect(sessionCookieName(true)).toBe('__Host-relaymon_session');
    expect(sessionCookieName(false)).toBe('relaymon_session');
  });
});
