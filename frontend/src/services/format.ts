import Decimal from 'decimal.js';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '暂无';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  const absolute = Math.abs(seconds);
  if (absolute < 60) return formatter.format(seconds, 'second');
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86_400), 'day');
}

export function formatDecimal(value: string, places = 3): string {
  try {
    const decimal = new Decimal(value);
    return decimal.toDecimalPlaces(places).toFixed();
  } catch {
    return value;
  }
}

export function formatMoney(value: string, currency = 'CNY'): string {
  let normalized = value;
  try {
    normalized = new Decimal(value).toDecimalPlaces(2).toFixed(2);
  } catch {
    return `${value} ${currency}`;
  }
  const symbol: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€' };
  return `${symbol[currency] ?? `${currency} `}${normalized}`;
}

export function compareDecimal(left: string, right: string): number {
  return new Decimal(left).comparedTo(new Decimal(right));
}

export function decimalBelow(value: string, threshold: string): boolean {
  try {
    return new Decimal(value).lessThan(new Decimal(threshold));
  } catch {
    return false;
  }
}

export function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
