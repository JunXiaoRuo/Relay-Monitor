import { describe, expect, it } from 'vitest';

import {
  adminPasswordNeedsRehash,
  hashAdminPassword,
  normalizeAdminUsername,
  verifyAdminPassword,
} from '../../backend/core/password.js';

describe('administrator passwords', () => {
  it('uses Argon2id and verifies without throwing on malformed hashes', async () => {
    const hash = await hashAdminPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyAdminPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyAdminPassword(hash, 'incorrect password')).toBe(false);
    expect(await verifyAdminPassword('not-a-hash', 'incorrect password')).toBe(false);
    expect(adminPasswordNeedsRehash(hash)).toBe(false);
    expect(adminPasswordNeedsRehash('$argon2id$v=19$m=1024,t=1,p=1$bad$bad')).toBe(true);
  });

  it('normalizes usernames and enforces the password floor', async () => {
    expect(normalizeAdminUsername('  Admin.User  ')).toBe('admin.user');
    await expect(hashAdminPassword('too-short')).rejects.toThrow(/at least 12/i);
  });
});
