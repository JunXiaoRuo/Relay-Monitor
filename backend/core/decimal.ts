import { Decimal } from 'decimal.js';

export const PreciseDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1_000_000,
  toExpPos: 1_000_000,
});

export type DecimalInput = string | bigint | Decimal;

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function decimalSource(value: DecimalInput): string | Decimal {
  if (typeof value === 'number') {
    throw new TypeError('JavaScript numbers are not accepted for exact decimal values');
  }
  if (typeof value === 'bigint') return value.toString();
  if (Decimal.isDecimal(value)) return value;

  const source = value.trim();
  if (source.length === 0 || source.length > 1_000 || !DECIMAL_PATTERN.test(source)) {
    throw new TypeError('Invalid decimal string');
  }
  return source;
}

export function parseDecimal(value: DecimalInput): Decimal {
  const parsed = new PreciseDecimal(decimalSource(value));
  if (!parsed.isFinite()) throw new TypeError('Decimal value must be finite');
  return parsed;
}

export function normalizeDecimal(value: DecimalInput): string {
  const parsed = parseDecimal(value);
  return parsed.isZero() ? '0' : parsed.toFixed();
}

export function isDecimalString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    normalizeDecimal(value);
    return true;
  } catch {
    return false;
  }
}

export function compareDecimals(left: DecimalInput, right: DecimalInput): -1 | 0 | 1 {
  return parseDecimal(left).cmp(parseDecimal(right)) as -1 | 0 | 1;
}

export function decimalsEqual(left: DecimalInput, right: DecimalInput): boolean {
  return compareDecimals(left, right) === 0;
}

export function subtractDecimals(left: DecimalInput, right: DecimalInput): string {
  return normalizeDecimal(parseDecimal(left).minus(parseDecimal(right)));
}

export function absoluteDecimalDifference(left: DecimalInput, right: DecimalInput): string {
  return normalizeDecimal(parseDecimal(left).minus(parseDecimal(right)).abs());
}

export function decimalDirection(
  previous: DecimalInput,
  current: DecimalInput,
): 'up' | 'down' | 'unchanged' {
  const comparison = compareDecimals(current, previous);
  if (comparison > 0) return 'up';
  if (comparison < 0) return 'down';
  return 'unchanged';
}

export function sumDecimals(values: readonly DecimalInput[]): string {
  const sum = values.reduce<Decimal>((total, value) => total.plus(parseDecimal(value)), new PreciseDecimal(0));
  return normalizeDecimal(sum);
}
