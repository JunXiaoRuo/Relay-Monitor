import { absoluteDecimalDifference, compareDecimals, decimalsEqual, normalizeDecimal } from './decimal.js';

export type DecimalConditionOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type DecimalConditionOperatorInput =
  | DecimalConditionOperator
  | '='
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<=';

const DECIMAL_OPERATOR_ALIASES: Readonly<Record<string, DecimalConditionOperator>> = {
  '=': 'eq',
  '==': 'eq',
  eq: 'eq',
  '!=': 'ne',
  ne: 'ne',
  '>': 'gt',
  gt: 'gt',
  '>=': 'gte',
  gte: 'gte',
  '<': 'lt',
  lt: 'lt',
  '<=': 'lte',
  lte: 'lte',
};

export function normalizeDecimalConditionOperator(
  value: unknown,
  fallback: DecimalConditionOperator = 'lt',
): DecimalConditionOperator {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new TypeError('Decimal condition operator must be a string');
  const operator = DECIMAL_OPERATOR_ALIASES[value.trim().toLowerCase()];
  if (!operator) throw new TypeError(`Unsupported decimal condition operator: ${value}`);
  return operator;
}

export function evaluateDecimalCondition(
  value: string,
  operator: DecimalConditionOperatorInput,
  threshold: string,
): boolean {
  const comparison = compareDecimals(value, threshold);
  switch (normalizeDecimalConditionOperator(operator)) {
    case 'eq': return comparison === 0;
    case 'ne': return comparison !== 0;
    case 'gt': return comparison > 0;
    case 'gte': return comparison >= 0;
    case 'lt': return comparison < 0;
    case 'lte': return comparison <= 0;
  }
}

export function evaluateDecimalThreshold(input: {
  value: string;
  operator?: DecimalConditionOperatorInput | undefined;
  threshold: string;
  recoveryThreshold?: string | undefined;
  useRecoveryThreshold?: boolean | undefined;
}): boolean {
  const operator = normalizeDecimalConditionOperator(input.operator);
  const threshold = input.useRecoveryThreshold && input.recoveryThreshold !== undefined
    ? input.recoveryThreshold
    : input.threshold;
  return evaluateDecimalCondition(input.value, operator, threshold);
}

export function decimalChangeDirection(
  previousValue: string,
  value: string,
): 'up' | 'down' | 'unchanged' {
  const comparison = compareDecimals(value, previousValue);
  if (comparison > 0) return 'up';
  if (comparison < 0) return 'down';
  return 'unchanged';
}

export function decimalChangeAtLeast(
  previousValue: string,
  value: string,
  minimumChange: string,
): boolean {
  return compareDecimals(absoluteDecimalDifference(value, previousValue), minimumChange) >= 0;
}

export function normalizedDecimalPair(
  value: string,
  previousValue?: string | null,
): { value: string; previousValue: string | null; changed: boolean } {
  const normalizedValue = normalizeDecimal(value);
  const normalizedPrevious = previousValue === undefined || previousValue === null
    ? null
    : normalizeDecimal(previousValue);
  return {
    value: normalizedValue,
    previousValue: normalizedPrevious,
    changed: normalizedPrevious !== null && !decimalsEqual(normalizedPrevious, normalizedValue),
  };
}
