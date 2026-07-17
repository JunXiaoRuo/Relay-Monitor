import { describe, expect, it, vi } from 'vitest';

import {
  clampPage,
  fetchAllPages,
  slicePage,
  totalPages,
} from '../../frontend/src/services/pagination.js';
import { beijingDateTimeToIso, buildQueryString } from '../../frontend/src/services/query.js';

describe('frontend pagination helpers', () => {
  it('clamps page numbers and slices a stable local page', () => {
    expect(totalPages(41, 20)).toBe(3);
    expect(clampPage(9, 41, 20)).toBe(3);
    expect(clampPage(0, 0, 20)).toBe(1);
    expect(slicePage([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
    expect(slicePage([1, 2, 3, 4, 5], 99, 2)).toEqual([5]);
  });

  it('loads every server page and stops when the advertised total is reached', async () => {
    const source = Array.from({ length: 405 }, (_, index) => index + 1);
    const loader = vi.fn(async (page: number, pageSize: number) => ({
      items: source.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total: source.length,
    }));

    await expect(fetchAllPages(loader)).resolves.toEqual(source);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('rejects repeated pages and enforces a maximum-page guard', async () => {
    await expect(fetchAllPages(async () => ({
      items: ['repeated'], page: 1, page_size: 1, total: 3,
    }), { pageSize: 1 })).rejects.toThrow('预期为第 2 页');

    await expect(fetchAllPages(async (page) => ({
      items: [page], page, page_size: 1, total: 10,
    }), { pageSize: 1, maxPages: 2 })).rejects.toThrow('安全加载上限');
  });
});

describe('frontend API query helpers', () => {
  it('encodes query values and omits empty filters', () => {
    expect(buildQueryString({ page: 2, page_size: 20, search: '请求 ID', result: undefined, empty: '' }))
      .toBe('?page=2&page_size=20&search=%E8%AF%B7%E6%B1%82+ID');
  });

  it('converts datetime-local input as Beijing time regardless of host timezone', () => {
    expect(beijingDateTimeToIso('2026-07-15T08:30')).toBe('2026-07-15T00:30:00.000Z');
    expect(beijingDateTimeToIso('')).toBeUndefined();
    expect(() => beijingDateTimeToIso('not-a-date')).toThrow('时间格式无效');
    expect(() => beijingDateTimeToIso('2026-02-31T08:30')).toThrow('时间无效');
  });
});
