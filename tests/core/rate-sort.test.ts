import { describe, expect, it } from 'vitest';

import { sortRatesByMultiplier } from '../../frontend/src/services/rate-sort.js';

const rates = [
  {
    id: 'first',
    value: '0.12',
    attributes: { base_rate: '0.12', user_rate: '0.08', effective_rate: '0.08' },
  },
  {
    id: 'second',
    value: '10',
    attributes: { base_rate: '10.00000000000000000001', effective_rate: '10' },
  },
  {
    id: 'third',
    value: '0.8',
    attributes: { base_rate: '0.8', user_rate: '0.8', effective_rate: '0.8' },
  },
  {
    id: 'same',
    value: '0.800',
    attributes: { base_rate: '0.800', user_rate: '0.800', effective_rate: '0.800' },
  },
];

describe('rate multiplier sorting', () => {
  it('sorts exact decimal strings without converting them to binary floating point', () => {
    expect(sortRatesByMultiplier(rates, 'base-asc').map(({ id }) => id))
      .toEqual(['first', 'third', 'same', 'second']);
    expect(sortRatesByMultiplier(rates, 'effective-desc').map(({ id }) => id))
      .toEqual(['second', 'third', 'same', 'first']);
  });

  it('keeps missing user multipliers last in both directions and preserves stable ties', () => {
    expect(sortRatesByMultiplier(rates, 'user-asc').map(({ id }) => id))
      .toEqual(['first', 'third', 'same', 'second']);
    expect(sortRatesByMultiplier(rates, 'user-desc').map(({ id }) => id))
      .toEqual(['third', 'same', 'first', 'second']);
  });

  it('preserves the source order in default mode', () => {
    expect(sortRatesByMultiplier(rates, 'default').map(({ id }) => id))
      .toEqual(['first', 'second', 'third', 'same']);
  });

  it('places malformed and non-finite values after valid multipliers', () => {
    const damaged = [
      { id: 'nan', value: 'NaN', attributes: {} },
      { id: 'valid', value: '0.5', attributes: {} },
      { id: 'infinity', value: 'Infinity', attributes: {} },
    ];
    expect(sortRatesByMultiplier(damaged, 'effective-asc').map(({ id }) => id))
      .toEqual(['valid', 'nan', 'infinity']);
  });
});
