import { describe, expect, it } from 'vitest';

import {
  decimalChangeAtLeast,
  evaluateDecimalCondition,
  evaluateDecimalThreshold,
  normalizeDecimalConditionOperator,
} from '../../backend/core/alert-conditions.js';

describe('alert conditions', () => {
  it('supports common operator aliases with exact decimal strings', () => {
    expect(evaluateDecimalCondition('9007199254740993.000000000000000001', '>', '9007199254740993')).toBe(true);
    expect(evaluateDecimalCondition('0.1200', 'eq', '0.12')).toBe(true);
    expect(evaluateDecimalCondition('-1', '<=', '-1.000')).toBe(true);
    expect(evaluateDecimalCondition('1', '!=', '1.000000000000000001')).toBe(true);
    expect(normalizeDecimalConditionOperator('>=')).toBe('gte');
  });

  it('uses the recovery threshold to implement hysteresis', () => {
    const condition = {
      value: '11',
      operator: 'lt' as const,
      threshold: '10',
      recoveryThreshold: '12',
    };
    expect(evaluateDecimalThreshold(condition)).toBe(false);
    expect(evaluateDecimalThreshold({ ...condition, useRecoveryThreshold: true })).toBe(true);
    expect(evaluateDecimalThreshold({ ...condition, value: '12', useRecoveryThreshold: true })).toBe(false);
  });

  it('checks minimum absolute changes without floating point conversion', () => {
    expect(decimalChangeAtLeast('0.12000000000000000001', '0.12000000000000000003', '0.00000000000000000002')).toBe(true);
    expect(decimalChangeAtLeast('0.12000000000000000001', '0.12000000000000000002', '0.00000000000000000002')).toBe(false);
  });
});
