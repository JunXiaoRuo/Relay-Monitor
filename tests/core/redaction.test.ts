import { describe, expect, it } from 'vitest';

import { REDACTED, redact, redactHeaders, redactString, redactUrl } from '../../backend/core/redaction.js';

describe('log redaction', () => {
  it('redacts nested secret keys without mutating input', () => {
    const input = {
      email: 'operator@example.com',
      credentials: { access_token: 'token-value', password: 'password-value' },
      nested: [{ apiKey: 'sk-1234567890' }],
    };

    expect(redact(input)).toEqual({
      email: 'operator@example.com',
      credentials: {
        access_token: REDACTED,
        password: REDACTED,
      },
      nested: [{ apiKey: REDACTED }],
    });
    expect(input.credentials.password).toBe('password-value');
  });

  it('redacts headers, bearer values, JWTs, API keys, and URL query secrets', () => {
    expect(redactHeaders({ Authorization: 'Bearer abc.def.ghi', Cookie: 'sid=secret', 'X-API-Key': 'custom-key', Accept: 'json' })).toEqual({
      Authorization: REDACTED,
      Cookie: REDACTED,
      'X-API-Key': REDACTED,
      Accept: 'json',
    });
    expect(redactString('key=sk-abcdefgh and Authorization: Bearer abcdef')).not.toContain('abcdefgh');
    expect(redactString('temp_token=one-time-login-ticket')).not.toContain('one-time-login-ticket');
    expect(redactUrl('https://user:pass@example.com/hook?api_key=secret&mode=test')).not.toContain('secret');
  });
});
