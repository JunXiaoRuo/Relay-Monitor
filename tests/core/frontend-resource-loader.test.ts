import { describe, expect, it, vi } from 'vitest';

import { loadResource } from '../../frontend/src/services/resource-loader.js';

describe('loadResource', () => {
  it('returns data from the API loader', async () => {
    const loader = vi.fn(async () => ({ value: 'api' }));

    await expect(loadResource(loader, { value: 'empty' })).resolves.toEqual({
      data: { value: 'api' },
      error: null,
    });
    expect(loader).toHaveBeenCalledOnce();
  });

  it('keeps API failures visible and returns only the caller-provided empty state', async () => {
    const loader = vi.fn(async () => { throw new Error('offline'); });

    await expect(loadResource(loader, { value: 'empty' })).resolves.toEqual({
      data: { value: 'empty' },
      error: 'offline',
    });
    expect(loader).toHaveBeenCalledOnce();
  });
});
