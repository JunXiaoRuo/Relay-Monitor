import type { Page } from '../../../shared/types';

export const DEFAULT_PAGE_SIZE = 20;
export const FETCH_ALL_PAGE_SIZE = 200;
export const MAX_FETCH_ALL_PAGES = 100;

export function totalPages(total: number, pageSize: number): number {
  const normalizedSize = Math.max(1, Math.trunc(pageSize));
  return Math.max(1, Math.ceil(Math.max(0, total) / normalizedSize));
}

export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, Math.trunc(page)), totalPages(total, pageSize));
}

export function slicePage<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const normalizedSize = Math.max(1, Math.trunc(pageSize));
  const normalizedPage = clampPage(page, items.length, normalizedSize);
  const start = (normalizedPage - 1) * normalizedSize;
  return items.slice(start, start + normalizedSize);
}

export interface FetchAllPagesOptions {
  pageSize?: number;
  maxPages?: number;
}

export async function fetchAllPages<T>(
  loader: (page: number, pageSize: number) => Promise<Page<T>>,
  options: FetchAllPagesOptions = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? FETCH_ALL_PAGE_SIZE));
  const maxPages = Math.max(1, Math.trunc(options.maxPages ?? MAX_FETCH_ALL_PAGES));
  const items: T[] = [];

  for (let requestedPage = 1; requestedPage <= maxPages; requestedPage += 1) {
    const response = await loader(requestedPage, pageSize);
    if (response.page !== requestedPage) {
      throw new Error(`分页接口返回第 ${response.page} 页，预期为第 ${requestedPage} 页，已停止加载。`);
    }

    items.push(...response.items);
    if (response.items.length === 0 || items.length >= response.total) return items.slice(0, response.total);

    const expectedPages = Math.ceil(response.total / Math.max(1, response.page_size));
    if (requestedPage >= expectedPages) return items;
  }

  throw new Error(`记录超过安全加载上限（${maxPages} 页），请缩小查询范围。`);
}
