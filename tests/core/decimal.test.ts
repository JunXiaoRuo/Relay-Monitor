import { describe, expect, it } from 'vitest';

import {
  absoluteDecimalDifference,
  compareDecimals,
  decimalDirection,
  decimalsEqual,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
} from '../../backend/core/decimal.js';

describe('exact decimal handling', () => {
  it('normalizes equivalent values without passing through a JS number', () => {
    expect(normalizeDecimal('0.120')).toBe('0.12');
    expect(normalizeDecimal('1.2300e+3')).toBe('1230');
    expect(normalizeDecimal('-0.000')).toBe('0');
    expect(decimalsEqual('0.12', '0.120')).toBe(true);
  });

  it('compares and calculates values exactly', () => {
    expect(compareDecimals('9007199254740993.1', '9007199254740993')).toBe(1);
    expect(subtractDecimals('0.3', '0.1')).toBe('0.2');
    expect(absoluteDecimalDifference('0.1', '0.3')).toBe('0.2');
    expect(sumDecimals(['0.1', '0.2', '0.3'])).toBe('0.6');
    expect(decimalDirection('0.120', '0.12')).toBe('unchanged');
    expect(decimalDirection('0.12', '0.13')).toBe('up');
  });

  it('rejects numbers and non-finite or malformed input', () => {
    expect(() => normalizeDecimal(0.1 as never)).toThrow(/numbers are not accepted/i);
    expect(() => normalizeDecimal('NaN')).toThrow(/invalid decimal/i);
    expect(() => normalizeDecimal('1,000')).toThrow(/invalid decimal/i);
  });
});
