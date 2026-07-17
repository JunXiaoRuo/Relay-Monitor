import { createHash } from 'node:crypto';

import { isLosslessNumber, type LosslessNumber } from 'lossless-json';

import type { NormalizedRate, NormalizedRateSnapshot } from '../adapters/contracts/types.js';
import {
  compareDecimals as compareExactDecimals,
  decimalsEqual,
  normalizeDecimal as normalizeExactDecimal,
  subtractDecimals as subtractExactDecimals,
  type DecimalInput as ExactDecimalInput,
} from './decimal.js';

export type DecimalInput = ExactDecimalInput | LosslessNumber;

function exactInput(value: DecimalInput): ExactDecimalInput {
  return isLosslessNumber(value) ? value.toString() : value;
}

export function normalizeDecimal(value: DecimalInput): string {
  return normalizeExactDecimal(exactInput(value));
}

export function decimalEquals(left: DecimalInput, right: DecimalInput): boolean {
  return decimalsEqual(exactInput(left), exactInput(right));
}

export function compareDecimals(left: DecimalInput, right: DecimalInput): -1 | 0 | 1 {
  return compareExactDecimals(exactInput(left), exactInput(right));
}

export function subtractDecimals(left: DecimalInput, right: DecimalInput): string {
  return subtractExactDecimals(exactInput(left), exactInput(right));
}

export interface StableFingerprintOptions {
  ignoredKeys?: ReadonlySet<string>;
  ignoreArrayOrder?: boolean;
  normalizeNumericStrings?: boolean;
}

const DEFAULT_VOLATILE_KEYS = new Set([
  'collectedAt',
  'collected_at',
  'detectedAt',
  'detected_at',
  'lastCheckedAt',
  'last_checked_at',
  'timestamp',
  'updatedAt',
  'updated_at',
  'latencyMs',
]);

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function canonicalize(value: unknown, options: Required<StableFingerprintOptions>): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (isLosslessNumber(value)) return normalizeDecimal(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Fingerprint input must not contain non-finite numbers');
    return value;
  }
  if (typeof value === 'string') {
    return options.normalizeNumericStrings && DECIMAL_PATTERN.test(value)
      ? normalizeDecimal(value)
      : value;
  }
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalize(entry, options));
    if (!options.ignoreArrayOrder) return items;
    return items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entry]) => !options.ignoredKeys.has(key) && entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry, options)]),
    );
  }
  throw new Error(`Unsupported fingerprint value type: ${typeof value}`);
}

export function stableCanonicalJson(value: unknown, options: StableFingerprintOptions = {}): string {
  const canonical = canonicalize(value, {
    ignoredKeys: options.ignoredKeys ?? DEFAULT_VOLATILE_KEYS,
    ignoreArrayOrder: options.ignoreArrayOrder ?? true,
    normalizeNumericStrings: options.normalizeNumericStrings ?? false,
  });
  return JSON.stringify(canonical);
}

export function stableFingerprint(value: unknown, options: StableFingerprintOptions = {}): string {
  return createHash('sha256').update(stableCanonicalJson(value, options), 'utf8').digest('hex');
}

function normalizedRateForFingerprint(rate: NormalizedRate): NormalizedRate {
  return {
    ...rate,
    value: rate.value === null ? null : normalizeDecimal(rate.value),
  };
}

export function rateSnapshotFingerprint(
  snapshot: Pick<NormalizedRateSnapshot, 'quality' | 'rates' | 'sources'>,
): string {
  return stableFingerprint(
    {
      quality: snapshot.quality,
      rates: snapshot.rates.map(normalizedRateForFingerprint),
      sources: snapshot.sources,
    },
    { normalizeNumericStrings: true },
  );
}

export type RateChangeKind = 'added' | 'removed' | 'value_changed' | 'billing_semantics_changed';

export interface TrustedRateState {
  initialized: boolean;
  rates: Readonly<Record<string, NormalizedRate>>;
  lastCompleteAt?: string;
  lastSnapshotAt?: string;
}

export interface ConfirmedRateChange {
  kind: RateChangeKind;
  rateKey: string;
  previous?: NormalizedRate;
  current?: NormalizedRate;
  direction?: 'up' | 'down' | 'unchanged';
  confirmedAt: string;
}

export interface AppliedRateSnapshot {
  state: TrustedRateState;
  accepted: boolean;
  baselineEstablished: boolean;
  changes: readonly ConfirmedRateChange[];
}

export function emptyTrustedRateState(): TrustedRateState {
  return { initialized: false, rates: {} };
}

function cloneRate(rate: NormalizedRate): NormalizedRate {
  return {
    ...rate,
    ...(rate.attributes ? { attributes: { ...rate.attributes } } : {}),
    value: rate.value === null ? null : normalizeDecimal(rate.value),
  };
}

function cloneState(state: TrustedRateState): TrustedRateState {
  return {
    initialized: state.initialized,
    rates: Object.fromEntries(Object.entries(state.rates).map(([key, rate]) => [key, cloneRate(rate)])),
    ...(state.lastCompleteAt ? { lastCompleteAt: state.lastCompleteAt } : {}),
    ...(state.lastSnapshotAt ? { lastSnapshotAt: state.lastSnapshotAt } : {}),
  };
}

function rateValueEquals(left: NormalizedRate, right: NormalizedRate): boolean {
  if (left.value === null || right.value === null) return left.value === right.value;
  return decimalEquals(left.value, right.value);
}

function changeDirection(previous: NormalizedRate, current: NormalizedRate): 'up' | 'down' | 'unchanged' {
  if (previous.value === null || current.value === null) return 'unchanged';
  const comparison = compareDecimals(current.value, previous.value);
  return comparison > 0 ? 'up' : comparison < 0 ? 'down' : 'unchanged';
}

export function applyTrustedRateSnapshot(
  previousState: TrustedRateState | undefined,
  snapshot: NormalizedRateSnapshot,
): AppliedRateSnapshot {
  const previous = cloneState(previousState ?? emptyTrustedRateState());
  if (snapshot.quality !== 'complete') {
    return {
      state: { ...previous, lastSnapshotAt: snapshot.collectedAt },
      accepted: false,
      baselineEstablished: false,
      changes: [],
    };
  }

  const incoming = Object.fromEntries(
    snapshot.rates.map((rate) => [rate.rateKey, cloneRate(rate)]),
  ) as Record<string, NormalizedRate>;
  if (!previous.initialized) {
    return {
      state: {
        initialized: true,
        rates: incoming,
        lastCompleteAt: snapshot.collectedAt,
        lastSnapshotAt: snapshot.collectedAt,
      },
      accepted: true,
      baselineEstablished: true,
      changes: [],
    };
  }

  const rates = { ...previous.rates } as Record<string, NormalizedRate>;
  const changes: ConfirmedRateChange[] = [];

  for (const [key, current] of Object.entries(incoming)) {
    const baseline = rates[key];
    if (!baseline) {
      rates[key] = current;
      changes.push({ kind: 'added', rateKey: key, current, confirmedAt: snapshot.collectedAt });
      continue;
    }

    if (baseline.comparisonKey !== current.comparisonKey) {
      rates[key] = current;
      changes.push({
        kind: 'billing_semantics_changed',
        rateKey: key,
        previous: baseline,
        current,
        confirmedAt: snapshot.collectedAt,
      });
      continue;
    }

    if (!rateValueEquals(baseline, current)) {
      rates[key] = current;
      changes.push({
        kind: 'value_changed',
        rateKey: key,
        previous: baseline,
        current,
        direction: changeDirection(baseline, current),
        confirmedAt: snapshot.collectedAt,
      });
      continue;
    }

    rates[key] = current;
  }

  for (const [key, baseline] of Object.entries(rates)) {
    if (incoming[key]) continue;
    delete rates[key];
    changes.push({
      kind: 'removed',
      rateKey: key,
      previous: baseline,
      confirmedAt: snapshot.collectedAt,
    });
  }

  return {
    state: {
      initialized: true,
      rates,
      lastCompleteAt: snapshot.collectedAt,
      lastSnapshotAt: snapshot.collectedAt,
    },
    accepted: true,
    baselineEstablished: false,
    changes,
  };
}

export interface ComparableRateExtrema {
  comparisonKey: string;
  minimumRateKeys: readonly string[];
  maximumRateKeys: readonly string[];
}

export function findComparableRateExtrema(rates: readonly NormalizedRate[]): ComparableRateExtrema[] {
  const groups = new Map<string, NormalizedRate[]>();
  for (const rate of rates) {
    if (
      rate.value === null ||
      rate.metadataStatus !== 'available' ||
      rate.dataQuality !== 'complete' ||
      rate.probeStatus === 'unavailable'
    ) {
      continue;
    }
    const group = groups.get(rate.comparisonKey) ?? [];
    group.push(rate);
    groups.set(rate.comparisonKey, group);
  }
  return [...groups.entries()].map(([comparisonKey, comparable]) => {
    const minimum = comparable.reduce((value, rate) =>
      compareDecimals(rate.value!, value) < 0 ? rate.value! : value,
    comparable[0]!.value!);
    const maximum = comparable.reduce((value, rate) =>
      compareDecimals(rate.value!, value) > 0 ? rate.value! : value,
    comparable[0]!.value!);
    return {
      comparisonKey,
      minimumRateKeys: comparable
        .filter((rate) => decimalEquals(rate.value!, minimum))
        .map((rate) => rate.rateKey),
      maximumRateKeys: comparable
        .filter((rate) => decimalEquals(rate.value!, maximum))
        .map((rate) => rate.rateKey),
    };
  });
}
