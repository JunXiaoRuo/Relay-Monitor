export type QueryValue = string | number | boolean | null | undefined;

export function buildQueryString(values: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export function beijingDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error('时间格式无效，请重新选择。');
  const [, year, month, day, hour, minute, second = '0'] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 8,
    Number(minute),
    Number(second),
  );
  const result = new Date(timestamp);
  const beijingView = new Date(timestamp + 8 * 60 * 60 * 1_000);
  if (
    Number.isNaN(result.getTime())
    || beijingView.getUTCFullYear() !== Number(year)
    || beijingView.getUTCMonth() !== Number(month) - 1
    || beijingView.getUTCDate() !== Number(day)
    || beijingView.getUTCHours() !== Number(hour)
    || beijingView.getUTCMinutes() !== Number(minute)
    || beijingView.getUTCSeconds() !== Number(second)
  ) throw new Error('时间无效，请重新选择。');
  return result.toISOString();
}
