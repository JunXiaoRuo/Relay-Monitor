import { describe, expect, it } from 'vitest';

import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  idempotencyRequestHash,
} from '../../backend/core/idempotency.js';
import { openDatabase } from '../../backend/db/index.js';

describe('idempotency keys', () => {
  it('hashes equivalent objects independently of property order', () => {
    expect(idempotencyRequestHash({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(idempotencyRequestHash({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('replays a completed response and rejects a conflicting request', () => {
    const database = openDatabase({ path: ':memory:' });
    const first = claimIdempotencyKey(database, {
      scope: 'admin:create-site', key: 'request-1', request: { name: 'Alpha' },
    });
    completeIdempotencyKey(database, first, {
      responseStatus: 201,
      responseBody: { data: { id: 'site_1' } },
      resourceId: 'site_1',
    });

    expect(claimIdempotencyKey(database, {
      scope: 'admin:create-site', key: 'request-1', request: { name: 'Alpha' },
    })).toEqual({
      kind: 'replay', responseStatus: 201, responseBody: { data: { id: 'site_1' } },
    });
    expect(() => claimIdempotencyKey(database, {
      scope: 'admin:create-site', key: 'request-1', request: { name: 'Beta' },
    })).toThrowError(/different request/i);
    database.close();
  });

  it('allows an explicitly failed operation to be retried', () => {
    const database = openDatabase({ path: ':memory:' });
    const first = claimIdempotencyKey(database, {
      scope: 'admin:create-site', key: 'request-2', request: { name: 'Alpha' },
    });
    failIdempotencyKey(database, first);
    expect(claimIdempotencyKey(database, {
      scope: 'admin:create-site', key: 'request-2', request: { name: 'Alpha' },
    }).kind).toBe('acquired');
    database.close();
  });
});
