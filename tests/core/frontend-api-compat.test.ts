import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../frontend/src/services/api.js';

function getRandomValuesOnly(): Crypto {
  let seed = 0;
  return {
    getRandomValues: (target: Uint8Array) => {
      target.set(Array.from({ length: target.length }, (_, index) => (seed + index) % 256));
      seed += 1;
      return target;
    },
  } as unknown as Crypto;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('frontend API compatibility', () => {
  it('does not expose the retired notification route client', () => {
    expect('routes' in api.notifications).toBe(false);
    expect('createRoute' in api.notifications).toBe(false);
    expect('updateRoute' in api.notifications).toBe(false);
    expect('deleteRoute' in api.notifications).toBe(false);
  });

  it('sends the login request when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', getRandomValuesOnly());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Request-ID')).toMatch(
        /^web_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      return new Response(JSON.stringify({
        data: { id: 'admin_1', username: 'admin', display_name: '管理员', timezone: 'Asia/Shanghai' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.session.login('admin', 'password')).resolves.toMatchObject({ username: 'admin' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session/login', expect.objectContaining({ method: 'POST' }));
  });

  it('generates distinct idempotency keys without randomUUID', async () => {
    vi.stubGlobal('crypto', getRandomValuesOnly());
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await api.sites.create({ name: 'first' });
    await api.sites.create({ name: 'second' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^idem_[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^idem_[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
