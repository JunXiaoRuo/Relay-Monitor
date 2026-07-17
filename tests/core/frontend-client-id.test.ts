import { describe, expect, it } from 'vitest';

import { createClientId } from '../../frontend/src/services/client-id.js';

describe('frontend client identifiers', () => {
  it('uses native randomUUID when the browser provides it', () => {
    const source = {
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    } as unknown as Crypto;
    expect(createClientId(source)).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('creates an RFC 4122 version 4 UUID with getRandomValues', () => {
    const source = {
      getRandomValues: (target: Uint8Array) => {
        target.set(Array.from({ length: 16 }, (_, index) => index));
        return target;
      },
    } as unknown as Crypto;
    expect(createClientId(source)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('falls back when Web Crypto is unavailable without reusing an identifier', () => {
    const first = createClientId(null);
    const second = createClientId(null);
    expect(first).toMatch(/^fallback-[a-z0-9-]+$/);
    expect(second).toMatch(/^fallback-[a-z0-9-]+$/);
    expect(second).not.toBe(first);
  });

  it('uses getRandomValues when an exposed randomUUID implementation throws', () => {
    const source = {
      randomUUID: () => { throw new Error('not available in this context'); },
      getRandomValues: (target: Uint8Array) => {
        target.fill(0xff);
        return target;
      },
    } as unknown as Crypto;
    expect(createClientId(source)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
