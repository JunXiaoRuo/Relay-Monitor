import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  AdapterError,
  adapterErrorPublicMessage,
  isAdapterError,
  type AuthUpdate,
  type MonitorType,
  type NormalizedRate,
} from '../adapters/index.js';
import type { AppContext } from '../context.js';
import {
  balanceSnapshots,
  balancesCurrent,
  healthChecks,
  monitorConfigs,
  monitorJobs,
  rateHistory,
  rateProbeRuns,
  rateSnapshots,
  ratesCurrent,
  sites,
} from '../db/index.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS } from '../../shared/constants.js';
import { compareDecimals, decimalsEqual, normalizeDecimal, subtractDecimals } from '../core/decimal.js';
import { createId } from '../core/ids.js';
import { errorMessage } from '../core/errors.js';
import { redactString } from '../core/redaction.js';
import { rateSnapshotFingerprint } from '../core/rate-snapshots.js';
import { createSafeFetchContext } from '../core/safe-fetch.js';
import {
  evaluateAlertRulesInTransaction,
  type RateAlertObservation,
} from './alert-engine.js';
import { loadCredentials, revokeCredentials, storeCredentials } from './credentials.js';
import { siteRateGroupAdapterMetadata } from './rate-scope.js';
import { bindPendingProbeKeyMapping } from './upstream-probe-keys.js';

const ACTIVE_RATE_PROBE_GRACE_MS = 2 * 60_000;

function hasRecentActiveRateProbe(context: AppContext, rateId: string): boolean {
  const run = context.database.db.select({
    startedAt: rateProbeRuns.startedAt,
    heartbeatAt: rateProbeRuns.heartbeatAt,
  })
    .from(rateProbeRuns)
    .where(and(eq(rateProbeRuns.rateId, rateId), eq(rateProbeRuns.status, 'running')))
    .orderBy(desc(rateProbeRuns.startedAt))
    .get();
  if (!run) return false;
  const activeAt = Date.parse(run.heartbeatAt ?? run.startedAt);
  return !Number.isFinite(activeAt) || Date.now() - activeAt < ACTIVE_RATE_PROBE_GRACE_MS;
}

export interface MonitorRunResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  retryable?: boolean;
}

function safeFetchOptions(context: AppContext) {
  return {
    allowHttp: !context.config.isProduction,
    allowedCidrs: context.config.outboundAllowedCidrs,
  };
}

function persistAuthUpdate(context: AppContext, siteId: string, update: AuthUpdate): void {
  const values = {
    access_token: update.accessToken,
    ...(update.refreshToken ? { refresh_token: update.refreshToken } : {}),
  };
  const write = () => {
    storeCredentials(context.database, context.vault, siteId, values, {
      persistKeys: Object.keys(values),
      expiresAtByKey: update.expiresAt ? { access_token: update.expiresAt } : {},
    });
    context.database.db.update(sites).set({
      authStatus: 'authenticated',
      ...(update.expiresAt ? { accessExpiresAt: update.expiresAt } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(sites.id, siteId)).run();
  };
  if (context.database.sqlite.inTransaction) write();
  else context.database.sqlite.transaction(write)();
}

function markRunSuccess(context: AppContext, siteId: string, at: string): void {
  context.database.db.update(sites).set({
    lastSuccessAt: at,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: at,
  }).where(eq(sites.id, siteId)).run();
}

interface MonitorFailure {
  errorCode: string;
  errorMessage: string;
  httpStatus?: number;
}

function monitorResourceKey(monitorType: MonitorType): string {
  if (monitorType === 'auth') return 'auth';
  if (monitorType === 'connectivity') return 'site';
  return `monitor:${monitorType}`;
}

function recordMonitorFailure(
  context: AppContext,
  siteId: string,
  monitorType: MonitorType,
  failure: MonitorFailure,
): void {
  const errorCode = failure.errorCode;
  const authError = errorCode.startsWith('AUTH_');
  const observedAt = new Date().toISOString();
  const status = errorCode === 'ADAPTER_UNAVAILABLE'
    ? 'adapter_unavailable' as const
    : errorCode === 'UPSTREAM_UNREACHABLE'
      ? 'down' as const
      : 'degraded' as const;
  context.database.db.update(sites).set({
    ...(monitorType === 'connectivity' ? { serviceStatus: status } : {}),
    ...(authError ? {
      authStatus: errorCode === 'AUTH_INVALID_CREDENTIALS'
        ? 'invalid_credentials'
        : errorCode === 'AUTH_INTERACTION_REQUIRED' || errorCode === 'AUTH_2FA_REQUIRED'
          ? 'interaction_required'
          : 'reauth_required',
    } : {}),
    lastErrorCode: errorCode,
    lastErrorMessage: failure.errorMessage,
    updatedAt: observedAt,
  }).where(eq(sites.id, siteId)).run();
  evaluateAlertRulesInTransaction(context.database, {
    kind: 'health',
    siteId,
    observedAt,
    status,
    authenticated: authError ? false : null,
    ...(authError ? {
      authStatus: errorCode === 'AUTH_INVALID_CREDENTIALS'
        ? 'invalid_credentials' as const
        : errorCode === 'AUTH_INTERACTION_REQUIRED' || errorCode === 'AUTH_2FA_REQUIRED'
          ? 'interaction_required' as const
          : 'reauth_required' as const,
      eventType: 'auth.failed',
    } : {}),
    resourceKey: monitorResourceKey(monitorType),
    probeKind: monitorType,
    errorCode,
    errorMessage: failure.errorMessage,
    details: {
      monitor_type: monitorType,
      http_status: failure.httpStatus ?? null,
    },
  });
  if (errorCode === 'ADAPTER_UNAVAILABLE') {
    context.database.db.update(monitorJobs).set({
      state: 'disabled',
      leaseOwner: null,
      leaseUntil: null,
      runRequested: false,
      lastErrorCode: errorCode,
      lastErrorMessage: failure.errorMessage,
      updatedAt: observedAt,
    }).where(eq(monitorJobs.siteId, siteId)).run();
  }
}

function markRunError(
  context: AppContext,
  siteId: string,
  monitorType: MonitorType,
  error: unknown,
): MonitorRunResult {
  const adapterError = error instanceof AdapterError ? error : undefined;
  const errorCode = adapterError?.code ?? 'MONITOR_RUN_FAILED';
  const publicMessage = adapterError
    ? adapterErrorPublicMessage(adapterError)
    : `监控任务执行失败：${redactString(errorMessage(error)).slice(0, 300)}`;
  recordMonitorFailure(context, siteId, monitorType, {
    errorCode,
    errorMessage: publicMessage,
    ...(adapterError?.httpStatus === undefined ? {} : { httpStatus: adapterError.httpStatus }),
  });
  return {
    success: false,
    errorCode,
    errorMessage: publicMessage,
    retryable: false,
  };
}

function recordMonitorRecovery(
  context: AppContext,
  siteId: string,
  monitorType: MonitorType,
  observedAt: string,
): void {
  evaluateAlertRulesInTransaction(context.database, {
    kind: 'health',
    siteId,
    observedAt,
    status: 'healthy',
    authenticated: monitorType === 'auth' ? true : null,
    ...(monitorType === 'auth' ? { authStatus: 'authenticated' as const, eventType: 'auth.failed' } : {}),
    resourceKey: monitorResourceKey(monitorType),
    probeKind: monitorType,
    details: { monitor_type: monitorType },
  });
}

function persistHealth(
  context: AppContext,
  siteId: string,
  result: Awaited<ReturnType<ReturnType<typeof context.adapters.get>['collectConnectivity']>>,
): void {
  const previous = context.database.db.select().from(healthChecks)
    .where(eq(healthChecks.siteId, siteId)).orderBy(desc(healthChecks.checkedAt)).get();
  const successful = result.status === 'healthy';
  const consecutiveSuccesses = successful ? (previous?.consecutiveSuccesses ?? 0) + 1 : 0;
  const consecutiveFailures = successful ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
  const serviceStatus = successful
    ? 'healthy'
    : result.errorCode?.startsWith('AUTH_')
      ? 'degraded'
      : consecutiveFailures >= 3 && result.status === 'down'
        ? 'down'
        : 'degraded';

  context.database.sqlite.transaction(() => {
    context.database.db.insert(healthChecks).values({
      id: createId('health'),
      siteId,
      probeKind: result.probeKind,
      success: successful,
      httpMs: result.latencyMs,
      totalMs: result.latencyMs,
      httpStatus: result.httpStatus ?? null,
      authPassed: result.authenticated,
      modelCount: result.modelCount ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      consecutiveSuccesses,
      consecutiveFailures,
      checkedAt: result.checkedAt,
    }).run();
    context.database.db.update(sites).set({
      serviceStatus,
      ...(result.probeKind === 'user_api' && result.authenticated === true ? {
        authStatus: 'authenticated' as const,
      } : result.probeKind === 'user_api' && result.authenticated === false ? {
        authStatus: result.errorCode === 'AUTH_INVALID_CREDENTIALS'
          ? 'invalid_credentials' as const
          : result.errorCode === 'AUTH_INTERACTION_REQUIRED' || result.errorCode === 'AUTH_2FA_REQUIRED'
            ? 'interaction_required' as const
            : 'reauth_required' as const,
      } : {}),
      lastErrorCode: result.errorCode ?? null,
      lastErrorMessage: result.errorMessage ?? null,
      ...(successful ? { lastSuccessAt: result.checkedAt } : {}),
      updatedAt: result.checkedAt,
    }).where(eq(sites.id, siteId)).run();
    if (result.authUpdate) persistAuthUpdate(context, siteId, result.authUpdate);
    evaluateAlertRulesInTransaction(context.database, {
      kind: 'health',
      siteId,
      observedAt: result.checkedAt,
      status: result.status,
      authenticated: result.authenticated,
      ...(result.probeKind === 'user_api' && result.authenticated === true ? {
        authStatus: 'authenticated' as const,
      } : result.probeKind === 'user_api' && result.authenticated === false ? {
        authStatus: result.errorCode === 'AUTH_INVALID_CREDENTIALS'
          ? 'invalid_credentials' as const
          : result.errorCode === 'AUTH_INTERACTION_REQUIRED' || result.errorCode === 'AUTH_2FA_REQUIRED'
            ? 'interaction_required' as const
            : 'reauth_required' as const,
      } : {}),
      probeKind: result.probeKind,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      latencyMs: result.latencyMs,
      details: {
        http_status: result.httpStatus ?? null,
        model_count: result.modelCount ?? null,
      },
    });
  })();
}

function persistBalances(
  context: AppContext,
  siteId: string,
  balances: Awaited<ReturnType<ReturnType<typeof context.adapters.get>['collectBalances']>>,
): void {
  context.database.sqlite.transaction(() => {
    for (const balance of balances) {
      const value = normalizeDecimal(balance.value);
      const current = context.database.db.select().from(balancesCurrent).where(and(
        eq(balancesCurrent.siteId, siteId), eq(balancesCurrent.balanceKey, balance.balanceKey),
      )).get();
      const snapshotId = createId('balsnap');
      const changeValue = current ? subtractDecimals(value, current.value) : null;
      context.database.db.insert(balanceSnapshots).values({
        id: snapshotId,
        siteId,
        balanceKey: balance.balanceKey,
        balanceKind: balance.balanceKind,
        value,
        available: balance.available ? normalizeDecimal(balance.available) : null,
        frozen: balance.frozen ? normalizeDecimal(balance.frozen) : null,
        total: balance.total ? normalizeDecimal(balance.total) : null,
        changeValue,
        unit: balance.unit,
        currency: balance.unit.length === 3 ? balance.unit : null,
        precision: balance.precision ?? null,
        sourceSemantics: JSON.stringify(balance.attributes ?? {}),
        loginReadable: true,
        collectedAt: balance.collectedAt,
      }).run();
      context.database.db.insert(balancesCurrent).values({
        id: createId('balance'),
        siteId,
        balanceKey: balance.balanceKey,
        balanceKind: balance.balanceKind,
        value,
        available: balance.available ? normalizeDecimal(balance.available) : null,
        frozen: balance.frozen ? normalizeDecimal(balance.frozen) : null,
        total: balance.total ? normalizeDecimal(balance.total) : null,
        changeValue,
        unit: balance.unit,
        currency: balance.unit.length === 3 ? balance.unit : null,
        precision: balance.precision ?? null,
        sourceSemantics: JSON.stringify(balance.attributes ?? {}),
        loginReadable: true,
        snapshotId,
        lastChangedAt: current && !decimalsEqual(current.value, value) ? balance.collectedAt : current?.lastChangedAt ?? null,
        lastCheckedAt: balance.collectedAt,
      }).onConflictDoUpdate({
        target: [balancesCurrent.siteId, balancesCurrent.balanceKey],
        set: {
          balanceKind: balance.balanceKind,
          value,
          available: balance.available ? normalizeDecimal(balance.available) : null,
          frozen: balance.frozen ? normalizeDecimal(balance.frozen) : null,
          total: balance.total ? normalizeDecimal(balance.total) : null,
          changeValue,
          unit: balance.unit,
          currency: balance.unit.length === 3 ? balance.unit : null,
          precision: balance.precision ?? null,
          sourceSemantics: JSON.stringify(balance.attributes ?? {}),
          snapshotId,
          lastChangedAt: current && !decimalsEqual(current.value, value) ? balance.collectedAt : current?.lastChangedAt ?? null,
          lastCheckedAt: balance.collectedAt,
          updatedAt: balance.collectedAt,
        },
      }).run();
      evaluateAlertRulesInTransaction(context.database, {
        kind: 'balance',
        siteId,
        observedAt: balance.collectedAt,
        balanceKey: balance.balanceKey,
        balanceKind: balance.balanceKind,
        value,
        unit: balance.unit,
        details: {
          available: balance.available ? normalizeDecimal(balance.available) : null,
          frozen: balance.frozen ? normalizeDecimal(balance.frozen) : null,
          total: balance.total ? normalizeDecimal(balance.total) : null,
          change_value: changeValue,
        },
      });
    }
  })();
}

function evaluateRateAlert(context: AppContext, observation: RateAlertObservation): void {
  evaluateAlertRulesInTransaction(context.database, observation);
}

function rateDirection(
  previousValue: string | null,
  value: string | null,
  semanticsChanged: boolean,
): 'up' | 'down' | 'unchanged' | undefined {
  if (semanticsChanged || previousValue === null || value === null) return undefined;
  const comparison = compareDecimals(value, previousValue);
  return comparison > 0 ? 'up' : comparison < 0 ? 'down' : 'unchanged';
}

function rateObservation(
  siteId: string,
  rate: NormalizedRate,
  previousValue: string | null,
  previousComparisonKey: string | null,
  changed: boolean,
  changeType: string,
): RateAlertObservation {
  const value = rate.value === null ? null : normalizeDecimal(rate.value);
  const semanticsChanged = previousComparisonKey !== null && previousComparisonKey !== rate.comparisonKey;
  const direction = rateDirection(previousValue, value, semanticsChanged);
  return {
    kind: 'rate',
    siteId,
    observedAt: rate.collectedAt,
    rateKey: rate.rateKey,
    rateKind: rate.rateKind,
    rateName: rate.name,
    value,
    previousValue,
    comparisonKey: rate.comparisonKey,
    ...(previousComparisonKey === null ? {} : { previousComparisonKey }),
    ...(rate.platform ? { platform: rate.platform } : {}),
    ...(direction ? { direction } : {}),
    changed,
    changeType,
    details: {
      unit: rate.unit,
      billing_expression: rate.billingExpression ?? null,
      match_confidence: rate.matchConfidence ?? 'high',
    },
  };
}

function missingRateObservation(
  current: typeof ratesCurrent.$inferSelect,
  observedAt: string,
  changed: boolean,
): RateAlertObservation {
  return {
    kind: 'rate',
    siteId: current.siteId,
    observedAt,
    rateKey: current.rateKey,
    rateKind: current.rateKind,
    rateName: current.name,
    value: null,
    previousValue: changed ? current.value : null,
    comparisonKey: current.comparisonKey,
    ...(changed ? { previousComparisonKey: current.comparisonKey } : {}),
    ...(current.platform ? { platform: current.platform } : {}),
    changed,
    changeType: changed ? 'removed' : 'unchanged',
    details: { unit: current.unit },
  };
}

function insertTrustedRate(
  context: AppContext,
  siteId: string,
  snapshotId: string,
  rate: NormalizedRate,
  baseline: boolean,
): void {
  if (rate.value === null) return;
  const value = normalizeDecimal(rate.value);
  const rateId = createId('rate');
  context.database.db.insert(ratesCurrent).values({
    id: rateId,
    siteId,
    rateKey: rate.rateKey,
    rateKind: rate.rateKind,
    name: rate.name,
    platform: rate.platform ?? null,
    groupName: rate.group ?? null,
    model: rate.model ?? null,
    value,
    unit: rate.unit,
    comparisonKey: rate.comparisonKey,
    billingExpression: rate.billingExpression ?? null,
    attributesJson: JSON.stringify(rate.attributes ?? {}),
    metadataStatus: 'available',
    probeStatus: rate.probeStatus,
    snapshotId,
    candidateValue: null,
    candidateCount: 0,
    firstSeenAt: rate.collectedAt,
    lastCheckedAt: rate.collectedAt,
    lastChangedAt: baseline ? null : rate.collectedAt,
    matchConfidence: rate.matchConfidence ?? 'high',
  }).run();
  if (!baseline) {
    context.database.db.insert(rateHistory).values({
      id: createId('ratehist'),
      siteId,
      rateKey: rate.rateKey,
      rateKind: rate.rateKind,
      changeType: 'added',
      newValue: value,
      newComparisonKey: rate.comparisonKey,
      snapshotId,
      confirmedAt: rate.collectedAt,
    }).run();
  }
  const inserted = context.database.db.select().from(ratesCurrent)
    .where(eq(ratesCurrent.id, rateId)).get();
  if (inserted) bindPendingProbeKeyMapping(context, inserted);
}

function acceptRateChange(
  context: AppContext,
  current: typeof ratesCurrent.$inferSelect,
  snapshotId: string,
  rate: NormalizedRate,
): void {
  if (rate.value === null) return;
  const value = normalizeDecimal(rate.value);
  const added = current.metadataStatus === 'stale' || current.removedAt !== null;
  const semanticsChanged = current.comparisonKey !== rate.comparisonKey;
  const direction = added || semanticsChanged
    ? null
    : compareDecimals(value, current.value) > 0
      ? 'up'
      : compareDecimals(value, current.value) < 0
        ? 'down'
        : 'unchanged';
  context.database.db.insert(rateHistory).values({
    id: createId('ratehist'),
    siteId: current.siteId,
    rateKey: current.rateKey,
    rateKind: current.rateKind,
    changeType: added ? 'added' : semanticsChanged ? 'billing_semantics_changed' : 'value_changed',
    direction,
    oldValue: added ? null : current.value,
    newValue: value,
    oldComparisonKey: added ? null : current.comparisonKey,
    newComparisonKey: rate.comparisonKey,
    snapshotId,
    confirmedAt: rate.collectedAt,
  }).run();
  context.database.db.update(ratesCurrent).set({
    rateKind: rate.rateKind,
    name: rate.name,
    platform: rate.platform ?? null,
    groupName: rate.group ?? null,
    model: rate.model ?? null,
    value,
    unit: rate.unit,
    comparisonKey: rate.comparisonKey,
    billingExpression: rate.billingExpression ?? null,
    attributesJson: JSON.stringify(rate.attributes ?? {}),
    metadataStatus: 'available',
    probeStatus: rate.probeStatus,
    snapshotId,
    candidateValue: null,
    candidateCount: 0,
    missingCount: 0,
    removedAt: null,
    lastCheckedAt: rate.collectedAt,
    lastChangedAt: rate.collectedAt,
    matchConfidence: rate.matchConfidence ?? 'high',
    updatedAt: rate.collectedAt,
  }).where(eq(ratesCurrent.id, current.id)).run();
}

function persistRates(
  context: AppContext,
  siteId: string,
  snapshot: Awaited<ReturnType<ReturnType<typeof context.adapters.get>['collectRates']>>,
): boolean {
  const snapshotId = createId('ratesnap');
  context.database.sqlite.transaction(() => {
    const latestSite = context.database.db.select().from(sites)
      .where(eq(sites.id, siteId)).get();
    if (!latestSite || latestSite.deletedAt !== null || !latestSite.enabled) return;
    const scope = siteRateGroupAdapterMetadata(latestSite).rate_group_scope as {
      mode: 'all' | 'selected';
      groupIds: string[];
      excluded_group_ids: string[];
    };
    const selected = scope.mode === 'selected' ? new Set(scope.groupIds) : null;
    const excluded = new Set(scope.excluded_group_ids);
    const scopedRates = snapshot.rates.filter((rate) => {
      if (rate.rateKind !== 'group') return true;
      const value = rate.attributes?.group_id;
      const groupId = typeof value === 'string' || typeof value === 'number' ? String(value) : null;
      if (!groupId) return selected === null;
      return (selected === null || selected.has(groupId)) && !excluded.has(groupId);
    });
    const scopedSnapshot = { ...snapshot, rates: scopedRates };
    const fingerprint = rateSnapshotFingerprint(scopedSnapshot);
    const hasCompleteBaseline = context.database.db
      .select({ id: rateSnapshots.id })
      .from(rateSnapshots)
      .where(and(eq(rateSnapshots.siteId, siteId), eq(rateSnapshots.quality, 'complete')))
      .get() !== undefined;
    context.database.db.insert(rateSnapshots).values({
      id: snapshotId,
      siteId,
      quality: snapshot.quality,
      fingerprint,
      itemCount: scopedRates.length,
      errorsJson: JSON.stringify(snapshot.sources.filter((source) => source.status !== 'success')),
      collectedAt: snapshot.collectedAt,
    }).run();
    if (snapshot.authUpdate) persistAuthUpdate(context, siteId, snapshot.authUpdate);
    if (snapshot.quality !== 'complete') return;

    const allExisting = context.database.db.select().from(ratesCurrent)
      .where(eq(ratesCurrent.siteId, siteId)).all();
    const existing = allExisting.filter((row) => row.removedAt === null);
    const baseline = !hasCompleteBaseline;
    const byKey = new Map(allExisting.map((row) => [row.rateKey, row]));
    const seen = new Set<string>();

    for (const rate of scopedRates) {
      if (rate.value === null) continue;
      seen.add(rate.rateKey);
      const current = byKey.get(rate.rateKey);
      if (!current) {
        insertTrustedRate(context, siteId, snapshotId, rate, baseline);
        evaluateRateAlert(context, rateObservation(
          siteId,
          rate,
          null,
          null,
          !baseline,
          baseline ? 'unchanged' : 'added',
        ));
        continue;
      }
      const changed = current.comparisonKey !== rate.comparisonKey || !decimalsEqual(current.value, rate.value);
      const added = current.metadataStatus === 'stale' || current.removedAt !== null;
      const previousValue = added ? null : current.value;
      const previousComparisonKey = added ? null : current.comparisonKey;
      const alertChanged = added || changed;
      if (alertChanged) {
        const changeType = added
          ? 'added'
          : current.comparisonKey !== rate.comparisonKey
            ? 'billing_semantics_changed'
            : 'value_changed';
        acceptRateChange(context, current, snapshotId, rate);
        const accepted = context.database.db.select().from(ratesCurrent)
          .where(eq(ratesCurrent.id, current.id)).get();
        if (accepted) bindPendingProbeKeyMapping(context, accepted);
        evaluateRateAlert(context, rateObservation(
          siteId,
          rate,
          previousValue,
          previousComparisonKey,
          true,
          changeType,
        ));
        continue;
      }
      evaluateRateAlert(context, rateObservation(
        siteId,
        rate,
        previousValue,
        previousComparisonKey,
        false,
        'unchanged',
      ));
      context.database.db.update(ratesCurrent).set({
        name: rate.name,
        platform: rate.platform ?? null,
        groupName: rate.group ?? null,
        model: rate.model ?? null,
        attributesJson: JSON.stringify(rate.attributes ?? {}),
        probeStatus: rate.probeStatus,
        candidateValue: null,
        candidateCount: 0,
        missingCount: 0,
        snapshotId,
        lastCheckedAt: rate.collectedAt,
        updatedAt: rate.collectedAt,
      }).where(eq(ratesCurrent.id, current.id)).run();
    }

    for (const current of existing) {
      if (seen.has(current.rateKey)) continue;
      if (current.metadataStatus === 'stale') {
        if (hasRecentActiveRateProbe(context, current.id)) {
          context.database.db.update(ratesCurrent).set({
            candidateValue: null,
            candidateCount: 0,
            missingCount: 0,
            snapshotId,
            lastCheckedAt: snapshot.collectedAt,
            updatedAt: snapshot.collectedAt,
          }).where(eq(ratesCurrent.id, current.id)).run();
          continue;
        }
        revokeCredentials(context.database, current.siteId, [`rate_probe:${current.id}:api_key`]);
        context.database.db.delete(ratesCurrent).where(eq(ratesCurrent.id, current.id)).run();
        continue;
      }
      const missingCount = current.missingCount + 1;
      context.database.db.insert(rateHistory).values({
        id: createId('ratehist'),
        siteId,
        rateKey: current.rateKey,
        rateKind: current.rateKind,
        changeType: 'removed',
        oldValue: current.value,
        oldComparisonKey: current.comparisonKey,
        snapshotId,
        confirmedAt: snapshot.collectedAt,
      }).run();
      context.database.db.update(ratesCurrent).set({
        metadataStatus: 'unavailable',
        missingCount,
        removedAt: snapshot.collectedAt,
        lastChangedAt: snapshot.collectedAt,
      }).where(eq(ratesCurrent.id, current.id)).run();
      evaluateRateAlert(context, missingRateObservation(current, snapshot.collectedAt, true));
    }

    for (const current of allExisting) {
      if (!current.removedAt || seen.has(current.rateKey)) continue;
      evaluateRateAlert(context, missingRateObservation(current, snapshot.collectedAt, false));
    }
  })();
  return snapshot.quality === 'complete';
}

async function runAuthMonitor(
  siteId: string,
  credentials: Record<string, string>,
  adapter: ReturnType<AppContext['adapters']['get']>,
  baseUrl: string,
  fetch: typeof globalThis.fetch,
): Promise<AuthUpdate> {
  const credentialKeys = new Set(adapter.manifest().credentialFields.map((field) => field.key));
  const authCredentials = Object.fromEntries(
    Object.entries(credentials).filter(([key]) => credentialKeys.has(key)),
  );
  const accessExpiresAt = credentials.access_expires_at
    ? Date.parse(credentials.access_expires_at)
    : Number.POSITIVE_INFINITY;
  let result;
  if (adapter.refreshAuth && accessExpiresAt - Date.now() < 10 * 60_000) {
    result = await adapter.refreshAuth({ siteId, baseUrl, credentials: authCredentials, fetch });
  } else {
    try {
      result = await adapter.authenticate({ siteId, baseUrl, credentials: authCredentials, fetch }, {
        mode: 'token',
        values: authCredentials,
      });
    } catch (error) {
      if (!adapter.refreshAuth || !isAdapterError(error, 'AUTH_ACCESS_EXPIRED')) throw error;
      result = await adapter.refreshAuth({ siteId, baseUrl, credentials: authCredentials, fetch });
    }
  }
  if (result.status !== 'authenticated') {
    throw new AdapterError('AUTH_INTERACTION_REQUIRED', result.message);
  }
  return {
    accessToken: result.tokens.accessToken,
    ...(result.tokens.refreshToken ? { refreshToken: result.tokens.refreshToken } : {}),
    ...(result.tokens.expiresAt ? { expiresAt: result.tokens.expiresAt } : {}),
  };
}

function commitWithLease(
  context: AppContext,
  leaseIsValid: () => boolean,
  write: () => void,
): boolean {
  const operation = (): boolean => {
    if (!leaseIsValid()) return false;
    write();
    return true;
  };
  if (context.database.sqlite.inTransaction) return operation();
  return context.database.sqlite.transaction(operation).immediate();
}

export async function runMonitor(
  context: AppContext,
  siteId: string,
  monitorType: MonitorType,
  signal: AbortSignal,
  leaseIsValid: () => boolean = () => true,
  priorAttempts = 0,
): Promise<MonitorRunResult> {
  const site = context.database.db.select().from(sites).where(and(
    eq(sites.id, siteId), isNull(sites.deletedAt), eq(sites.enabled, true),
  )).get();
  if (!site) return { success: true };
  const commitIsValid = (): boolean => {
    if (!leaseIsValid()) return false;
    const current = context.database.db.select({
      baseUrl: sites.baseUrl,
      enabled: sites.enabled,
      deletedAt: sites.deletedAt,
    }).from(sites).where(eq(sites.id, site.id)).get();
    return Boolean(
      current
      && current.enabled
      && current.deletedAt === null
      && current.baseUrl === site.baseUrl,
    );
  };
  let outbound;
  let pendingAuthUpdate: AuthUpdate | undefined;
  let monitorConfig: typeof monitorConfigs.$inferSelect | undefined;
  const commitAuthUpdate = (update: AuthUpdate | undefined): boolean => {
    if (!update) return commitIsValid();
    return commitWithLease(context, commitIsValid, () => persistAuthUpdate(context, site.id, update));
  };
  try {
    const adapter = context.adapters.get(site.adapterType);
    const credentials = loadCredentials(context.database, context.vault, site.id);
    if (site.accessExpiresAt) credentials.access_expires_at = site.accessExpiresAt;
    monitorConfig = context.database.db.select().from(monitorConfigs).where(and(
      eq(monitorConfigs.siteId, site.id), eq(monitorConfigs.monitorType, monitorType),
    )).get();
    const canRetry = (retryable: boolean): boolean => retryable
      && priorAttempts < (monitorConfig?.retryCount ?? 0);
    outbound = await createSafeFetchContext(site.baseUrl, safeFetchOptions(context));
    const siteContext = {
      siteId: site.id,
      baseUrl: outbound.baseUrl,
      credentials,
      fetch: outbound.fetch,
      timeoutMs: (monitorConfig?.timeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1_000,
      signal,
      adapterMetadata: siteRateGroupAdapterMetadata(site),
      onAuthUpdate: (update: AuthUpdate) => {
        pendingAuthUpdate = update;
      },
    };
    if (monitorType === 'connectivity') {
      const result = await adapter.collectConnectivity(siteContext);
      if (result.status !== 'healthy' && canRetry(result.retryable === true)) {
        if (!commitAuthUpdate(result.authUpdate ?? pendingAuthUpdate)) {
          return { success: false, errorCode: 'LEASE_LOST' };
        }
        return {
          success: false,
          errorCode: result.errorCode ?? 'MONITOR_CHECK_FAILED',
          retryable: true,
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
        };
      }
      const committed = commitWithLease(context, commitIsValid, () => {
        persistHealth(context, site.id, result);
        const authUpdate = result.authUpdate ?? pendingAuthUpdate;
        if (authUpdate) persistAuthUpdate(context, site.id, authUpdate);
      });
      if (!committed) return { success: false, errorCode: 'LEASE_LOST' };
      if (result.status !== 'healthy') {
        return {
          success: false,
          errorCode: result.errorCode ?? 'MONITOR_CHECK_FAILED',
          retryable: false,
        };
      }
    } else if (monitorType === 'balance') {
      const result = await adapter.collectBalances(siteContext);
      const committed = commitWithLease(context, commitIsValid, () => {
        persistBalances(context, site.id, result);
        if (pendingAuthUpdate) persistAuthUpdate(context, site.id, pendingAuthUpdate);
        const observedAt = new Date().toISOString();
        markRunSuccess(context, site.id, observedAt);
        recordMonitorRecovery(context, site.id, monitorType, observedAt);
      });
      if (!committed) return { success: false, errorCode: 'LEASE_LOST' };
    } else if (monitorType === 'rates') {
      const result = await adapter.collectRates(siteContext);
      const sourceError = result.sources.find((source) =>
        source.required && (source.status === 'failed' || source.status === 'incompatible')
      ) ?? result.sources.find((source) =>
        source.status === 'failed' || source.status === 'incompatible'
      );
      if (result.quality === 'partial' && canRetry(sourceError?.retryable === true)) {
        if (!commitAuthUpdate(result.authUpdate ?? pendingAuthUpdate)) {
          return { success: false, errorCode: 'LEASE_LOST' };
        }
        return {
          success: false,
          errorCode: sourceError?.errorCode ?? 'RATE_SNAPSHOT_PARTIAL',
          retryable: true,
          ...(sourceError?.retryAfterMs === undefined ? {} : { retryAfterMs: sourceError.retryAfterMs }),
        };
      }
      const committed = commitWithLease(context, commitIsValid, () => {
        const complete = persistRates(context, site.id, result);
        const authUpdate = result.authUpdate ?? pendingAuthUpdate;
        if (authUpdate) persistAuthUpdate(context, site.id, authUpdate);
        if (complete) {
          markRunSuccess(context, site.id, result.collectedAt);
          recordMonitorRecovery(context, site.id, monitorType, result.collectedAt);
        } else {
          recordMonitorFailure(context, site.id, monitorType, {
            errorCode: sourceError?.errorCode ?? 'RATE_SNAPSHOT_PARTIAL',
            errorMessage: '倍率采集只返回了部分数据，已保留上一份可信基线。',
          });
        }
      });
      if (!committed) return { success: false, errorCode: 'LEASE_LOST' };
      if (result.quality === 'partial') {
        return {
          success: false,
          errorCode: sourceError?.errorCode ?? 'RATE_SNAPSHOT_PARTIAL',
          retryable: false,
        };
      }
    } else {
      const update = await runAuthMonitor(site.id, credentials, adapter, outbound.baseUrl, outbound.fetch);
      const committed = commitWithLease(context, commitIsValid, () => {
        persistAuthUpdate(context, site.id, update);
        const observedAt = new Date().toISOString();
        markRunSuccess(context, site.id, observedAt);
        recordMonitorRecovery(context, site.id, monitorType, observedAt);
      });
      if (!committed) return { success: false, errorCode: 'LEASE_LOST' };
    }
    return { success: true };
  } catch (error) {
    if (signal.aborted) {
      return { success: false, errorCode: 'MONITOR_ABORTED', retryable: false };
    }
    const adapterError = error instanceof AdapterError ? error : undefined;
    if (adapterError?.retryable && priorAttempts < (monitorConfig?.retryCount ?? 0)) {
      if (!commitAuthUpdate(pendingAuthUpdate)) return { success: false, errorCode: 'LEASE_LOST' };
      return {
        success: false,
        errorCode: adapterError.code,
        retryable: true,
        ...(adapterError.retryAfterMs === undefined ? {} : { retryAfterMs: adapterError.retryAfterMs }),
      };
    }
    let result: MonitorRunResult = { success: false, errorCode: 'LEASE_LOST' };
    const committed = commitWithLease(context, commitIsValid, () => {
      if (pendingAuthUpdate) persistAuthUpdate(context, site.id, pendingAuthUpdate);
      result = markRunError(context, site.id, monitorType, error);
    });
    return committed ? result : { success: false, errorCode: 'LEASE_LOST' };
  } finally {
    await outbound?.close();
  }
}
