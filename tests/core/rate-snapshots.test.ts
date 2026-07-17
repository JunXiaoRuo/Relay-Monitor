import { parse as parseLosslessJson } from 'lossless-json';
import { describe, expect, it } from 'vitest';

import type { NormalizedRate, NormalizedRateSnapshot } from '../../backend/adapters/contracts/types.js';
import {
  applyTrustedRateSnapshot,
  decimalEquals,
  findComparableRateExtrema,
  normalizeDecimal,
  rateSnapshotFingerprint,
} from '../../backend/core/rate-snapshots.js';

function rate(
  rateKey: string,
  value: string,
  comparisonKey = 'sub2api:group:openai:effective:v1',
): NormalizedRate {
  return {
    rateKey,
    rateKind: 'group',
    name: rateKey,
    platform: 'openai',
    value,
    unit: 'multiplier',
    comparisonKey,
    metadataStatus: 'available',
    probeStatus: 'not_configured',
    collectedAt: '2026-07-14T00:00:00.000Z',
    dataQuality: 'complete',
  };
}

function snapshot(
  quality: NormalizedRateSnapshot['quality'],
  rates: readonly NormalizedRate[],
  collectedAt: string,
): NormalizedRateSnapshot {
  return {
    quality,
    rates,
    collectedAt,
    sources: [{ source: 'groups.available', required: true, status: quality === 'complete' ? 'success' : 'failed' }],
  };
}

describe('trusted rate snapshots', () => {
  it('normalizes lossless numbers without passing through a JavaScript number', () => {
    const parsed = parseLosslessJson('{"rate":9007199254740993.1200}') as { rate: never };
    expect(normalizeDecimal(parsed.rate)).toBe('9007199254740993.12');
    expect(decimalEquals('0.12', '0.120')).toBe(true);
  });

  it('produces a stable fingerprint across ordering, timestamps, and decimal formatting', () => {
    const first = snapshot(
      'complete',
      [rate('group:2:effective', '0.120'), rate('group:1:effective', '0.01')],
      '2026-07-14T00:00:00.000Z',
    );
    const second = snapshot(
      'complete',
      [rate('group:1:effective', '0.0100'), rate('group:2:effective', '0.12')],
      '2026-07-15T00:00:00.000Z',
    );
    expect(rateSnapshotFingerprint(first)).toBe(rateSnapshotFingerprint(second));
  });

  it('establishes a silent baseline, accepts the first complete change, and ignores equivalent decimals', () => {
    const baseline = applyTrustedRateSnapshot(
      undefined,
      snapshot('complete', [rate('group:1:effective', '0.120')], '2026-07-14T00:00:00.000Z'),
    );
    expect(baseline.baselineEstablished).toBe(true);
    expect(baseline.changes).toEqual([]);

    const equivalent = applyTrustedRateSnapshot(
      baseline.state,
      snapshot('complete', [rate('group:1:effective', '0.12')], '2026-07-14T00:05:00.000Z'),
    );
    expect(equivalent.changes).toEqual([]);

    const firstChange = applyTrustedRateSnapshot(
      equivalent.state,
      snapshot('complete', [rate('group:1:effective', '0.15')], '2026-07-14T00:10:00.000Z'),
    );
    expect(firstChange.changes).toHaveLength(1);
    expect(firstChange.changes[0]).toMatchObject({
      kind: 'value_changed',
      direction: 'up',
      confirmedAt: '2026-07-14T00:10:00.000Z',
    });
    expect(firstChange.state.rates['group:1:effective']?.value).toBe('0.15');

    const repeated = applyTrustedRateSnapshot(
      firstChange.state,
      snapshot('complete', [rate('group:1:effective', '0.150')], '2026-07-14T00:15:00.000Z'),
    );
    expect(repeated.changes).toEqual([]);
    expect(repeated.state.rates['group:1:effective']?.value).toBe('0.15');
  });

  it('does not alter accepted rates or remove them from a partial snapshot', () => {
    const baseline = applyTrustedRateSnapshot(
      undefined,
      snapshot('complete', [rate('group:1:effective', '0.12')], '2026-07-14T00:00:00.000Z'),
    );
    const accepted = applyTrustedRateSnapshot(
      baseline.state,
      snapshot('complete', [rate('group:1:effective', '0.15')], '2026-07-14T00:05:00.000Z'),
    );
    const partial = applyTrustedRateSnapshot(
      accepted.state,
      snapshot('partial', [], '2026-07-14T00:10:00.000Z'),
    );
    expect(partial.accepted).toBe(false);
    expect(partial.state.rates).toEqual(accepted.state.rates);
    expect(partial.changes).toEqual([]);
  });

  it('accepts a removal from the first complete missing snapshot without repeating it', () => {
    const baseline = applyTrustedRateSnapshot(
      undefined,
      snapshot('complete', [rate('group:1:effective', '0.12')], '2026-07-14T00:00:00.000Z'),
    );
    const removed = applyTrustedRateSnapshot(
      baseline.state,
      snapshot('complete', [], '2026-07-14T00:05:00.000Z'),
    );
    expect(removed.changes[0]).toMatchObject({
      kind: 'removed',
      confirmedAt: '2026-07-14T00:05:00.000Z',
    });
    expect(removed.state.rates['group:1:effective']).toBeUndefined();

    const repeated = applyTrustedRateSnapshot(
      removed.state,
      snapshot('complete', [], '2026-07-14T00:10:00.000Z'),
    );
    expect(repeated.changes).toEqual([]);
    expect(repeated.state.rates['group:1:effective']).toBeUndefined();
  });

  it('accepts additions, removals, and reappearances from their first complete snapshots', () => {
    const baseline = applyTrustedRateSnapshot(
      undefined,
      snapshot('complete', [rate('a', '0.12')], '2026-07-14T00:00:00.000Z'),
    );
    const firstAppearance = applyTrustedRateSnapshot(
      baseline.state,
      snapshot('complete', [rate('a', '0.12'), rate('b', '0.10')], '2026-07-14T00:05:00.000Z'),
    );
    const absent = applyTrustedRateSnapshot(
      firstAppearance.state,
      snapshot('complete', [rate('a', '0.12')], '2026-07-14T00:10:00.000Z'),
    );
    const appearsAgain = applyTrustedRateSnapshot(
      absent.state,
      snapshot('complete', [rate('a', '0.12'), rate('b', '0.10')], '2026-07-14T00:15:00.000Z'),
    );
    expect(firstAppearance.changes).toEqual([
      expect.objectContaining({ kind: 'added', rateKey: 'b' }),
    ]);
    expect(firstAppearance.state.rates.b?.value).toBe('0.1');
    expect(absent.changes).toEqual([
      expect.objectContaining({ kind: 'removed', rateKey: 'b' }),
    ]);
    expect(absent.state.rates.b).toBeUndefined();
    expect(appearsAgain.changes).toEqual([
      expect.objectContaining({ kind: 'added', rateKey: 'b' }),
    ]);
    expect(appearsAgain.state.rates.b?.value).toBe('0.1');
  });

  it('accepts a billing semantics change from the first complete snapshot', () => {
    const baseline = applyTrustedRateSnapshot(
      undefined,
      snapshot('complete', [rate('group:1:effective', '0.12')], '2026-07-14T00:00:00.000Z'),
    );
    const changed = applyTrustedRateSnapshot(
      baseline.state,
      snapshot(
        'complete',
        [rate('group:1:effective', '0.12', 'sub2api:group:openai:effective:v2')],
        '2026-07-14T00:05:00.000Z',
      ),
    );
    expect(changed.changes).toEqual([
      expect.objectContaining({
        kind: 'billing_semantics_changed',
        rateKey: 'group:1:effective',
        confirmedAt: '2026-07-14T00:05:00.000Z',
      }),
    ]);

    const repeated = applyTrustedRateSnapshot(
      changed.state,
      snapshot(
        'complete',
        [rate('group:1:effective', '0.120', 'sub2api:group:openai:effective:v2')],
        '2026-07-14T00:10:00.000Z',
      ),
    );
    expect(repeated.changes).toEqual([]);
  });

  it('computes extrema only inside an identical comparison key', () => {
    const extrema = findComparableRateExtrema([
      rate('a', '0.10', 'group:openai'),
      rate('b', '0.20', 'group:openai'),
      rate('c', '0.01', 'model:openai'),
    ]);
    expect(extrema).toContainEqual({
      comparisonKey: 'group:openai',
      minimumRateKeys: ['a'],
      maximumRateKeys: ['b'],
    });
    expect(extrema).toContainEqual({
      comparisonKey: 'model:openai',
      minimumRateKeys: ['c'],
      maximumRateKeys: ['c'],
    });
  });
});
