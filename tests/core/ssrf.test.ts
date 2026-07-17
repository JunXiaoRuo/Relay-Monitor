import { describe, expect, it } from 'vitest';

import {
  UnsafeUrlError,
  isPublicAddress,
  validateOutboundUrl,
  validateRedirect,
} from '../../backend/core/ssrf.js';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('outbound URL validation', () => {
  it('accepts HTTPS public hosts and pins the validated DNS answer', async () => {
    const validated = await validateOutboundUrl('https://example.com/webhook', { resolver: publicResolver });
    expect(validated.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);

    await new Promise<void>((resolve, reject) => {
      validated.lookup('example.com', { all: false }, (error, address, family) => {
        if (error) return reject(error);
        expect(address).toBe('93.184.216.34');
        expect(family).toBe(4);
        resolve();
      });
    });
  });

  it.each([
    'http://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://metadata.google.internal',
    'https://user:pass@example.com',
    'https://example.com/path?token=secret',
  ])('rejects unsafe URL %s', async (url) => {
    await expect(validateOutboundUrl(url, { resolver: publicResolver })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects every DNS set containing a private answer', async () => {
    await expect(
      validateOutboundUrl('https://example.com', {
        resolver: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.2', family: 4 },
        ],
      }),
    ).rejects.toThrow(/private or special-use/i);
  });

  it('only permits private destinations through an explicit CIDR', async () => {
    expect(isPublicAddress('10.20.30.40')).toBe(false);
    expect(isPublicAddress('10.20.30.40', ['10.20.0.0/16'])).toBe(true);
    await expect(
      validateOutboundUrl('https://hook.example.com', {
        resolver: async () => [{ address: '10.20.30.40', family: 4 }],
        allowedCidrs: ['10.20.0.0/16'],
      }),
    ).resolves.toBeDefined();
  });

  it('keeps the default site/upstream policy strict when the Webhook policy is not selected', async () => {
    const privateResolver = async () => [{ address: '192.168.31.76', family: 4 as const }];
    await expect(validateOutboundUrl('https://relay.example.com', {
      resolver: privateResolver,
    })).rejects.toThrow(/private or special-use/i);

    const webhookOnly = await validateOutboundUrl('https://relay.example.com', {
      resolver: privateResolver,
      allowWebhookPrivateAddresses: true,
    });
    expect(webhookOnly.addresses).toEqual([{ address: '192.168.31.76', family: 4 }]);
  });

  it('blocks cross-origin redirects and revalidates same-origin redirects', async () => {
    const current = await validateOutboundUrl('https://example.com/start', { resolver: publicResolver });
    await expect(validateRedirect(current, 'https://other.example/path', { resolver: publicResolver })).rejects.toThrow(
      /cross-origin/i,
    );
    await expect(validateRedirect(current, '/next', { resolver: publicResolver })).resolves.toBeDefined();
  });
});
