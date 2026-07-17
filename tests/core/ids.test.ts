import { describe, expect, it } from 'vitest';

import { createId, isId, parseId } from '../../backend/core/ids.js';

describe('prefixed IDs', () => {
  it('creates sortable, validated IDs with the timestamp encoded', () => {
    const timestamp = 1_721_000_000_123;
    const first = createId('site', timestamp);
    const later = createId('site', timestamp + 1);

    expect(isId(first, 'site')).toBe(true);
    expect(isId(first, 'evt')).toBe(false);
    expect(first < later).toBe(true);
    expect(parseId(first)).toEqual({ prefix: 'site', timestamp });
  });

  it('rejects unsafe prefixes and malformed values', () => {
    expect(() => createId('S')).toThrow(/prefix/i);
    expect(isId('site_not-an-id')).toBe(false);
  });
});
