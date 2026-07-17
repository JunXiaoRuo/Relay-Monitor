import { describe, expect, it } from 'vitest';

import {
  AdapterError,
  AdapterRegistry,
  createBuiltinAdapterRegistry,
  Sub2ApiAdapter,
  sub2ApiCredentialSchema,
  sub2ApiManifest,
} from '../../backend/adapters/index.js';

describe('relay adapter contract', () => {
  it('publishes a versioned, non-executable manifest', () => {
    const manifest = sub2ApiManifest();
    expect(manifest).toMatchObject({
      contractVersion: '1.0',
      adapterType: 'sub2api',
      adapterVersion: '1.0.0',
      adapterSchemaVersion: 1,
      monitorTypes: expect.arrayContaining(['auth', 'balance', 'connectivity', 'rates']),
      capabilities: {
        authRefresh: true,
        balances: true,
        rates: true,
        channels: true,
        activeProbe: true,
      },
    });
    expect(manifest.sensitiveFields).toEqual(
      expect.arrayContaining(['password', 'access_token', 'refresh_token', 'api_key', 'totp_code']),
    );
    expect(JSON.stringify(manifest)).not.toContain('<script');
  });

  it('validates conditional credentials and rejects transient challenge persistence', () => {
    expect(
      sub2ApiCredentialSchema.safeParse({ mode: 'password', values: { email: 'user@example.com' } })
        .success,
    ).toBe(false);
    expect(
      sub2ApiCredentialSchema.safeParse({
        mode: 'token',
        values: { access_token: 'access' },
        persistKeys: ['access_token'],
      }).success,
    ).toBe(true);
    expect(
      sub2ApiCredentialSchema.safeParse({
        mode: 'password',
        values: { email: 'user@example.com', password: 'secret', totp_code: '123456' },
        persistKeys: ['totp_code'],
      }).success,
    ).toBe(false);
  });

  it('registers only explicit built-ins and never guesses an unknown adapter', () => {
    const registry = createBuiltinAdapterRegistry();
    expect(registry.manifests().map((manifest) => manifest.adapterType)).toEqual(['sub2api']);
    expect(registry.get('sub2api')).toBeInstanceOf(Sub2ApiAdapter);
    expect(() => registry.get('new-api')).toThrowError(
      expect.objectContaining<Partial<AdapterError>>({ code: 'ADAPTER_UNAVAILABLE' }),
    );
    expect(() => new AdapterRegistry([new Sub2ApiAdapter(), new Sub2ApiAdapter()])).toThrow(
      /already registered/,
    );
  });

  it('exposes a generic auth challenge method to callers', () => {
    const adapter = createBuiltinAdapterRegistry().get('sub2api');
    expect(adapter.completeAuthChallenge).toBeTypeOf('function');
  });
});
