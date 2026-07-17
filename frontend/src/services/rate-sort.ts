import Decimal from 'decimal.js';

export type RateSortMode =
  | 'default'
  | 'base-asc'
  | 'base-desc'
  | 'user-asc'
  | 'user-desc'
  | 'effective-asc'
  | 'effective-desc';

export type RateSortField = 'base' | 'user' | 'effective';
export type RateSortDirection = 'asc' | 'desc';

interface SortableRate {
  value: string;
  attributes: Readonly<Record<string, unknown>>;
}

const SORT_DEFINITIONS: Readonly<Record<Exclude<RateSortMode, 'default'>, {
  field: RateSortField;
  direction: RateSortDirection;
}>> = {
  'base-asc': { field: 'base', direction: 'asc' },
  'base-desc': { field: 'base', direction: 'desc' },
  'user-asc': { field: 'user', direction: 'asc' },
  'user-desc': { field: 'user', direction: 'desc' },
  'effective-asc': { field: 'effective', direction: 'asc' },
  'effective-desc': { field: 'effective', direction: 'desc' },
};

function decimalValue(rate: SortableRate, field: RateSortField): Decimal | null {
  const attributeKey = `${field}_rate`;
  const attribute = rate.attributes[attributeKey];
  const raw = typeof attribute === 'string'
    ? attribute
    : field === 'user'
      ? null
      : rate.value;
  if (raw === null) return null;
  try {
    const decimal = new Decimal(raw);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

export function rateSortDefinition(mode: RateSortMode): {
  field: RateSortField;
  direction: RateSortDirection;
} | null {
  return mode === 'default' ? null : SORT_DEFINITIONS[mode];
}

export function sortRatesByMultiplier<T extends SortableRate>(
  rates: readonly T[],
  mode: RateSortMode,
): T[] {
  const definition = rateSortDefinition(mode);
  if (!definition) return [...rates];

  return rates
    .map((rate, index) => ({ rate, index, value: decimalValue(rate, definition.field) }))
    .sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      const comparison = left.value.comparedTo(right.value);
      if (comparison === 0) return left.index - right.index;
      return definition.direction === 'asc' ? comparison : -comparison;
    })
    .map(({ rate }) => rate);
}
