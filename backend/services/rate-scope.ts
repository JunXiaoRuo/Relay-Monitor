import { and, eq } from 'drizzle-orm';

import type { AppContext } from '../context.js';
import {
  rateHistory,
  rateProbeConfigs,
  ratesCurrent,
  siteProbeKeyMappings,
  sites,
  type Site,
} from '../db/index.js';
import { AppError } from '../core/errors.js';
import { createId } from '../core/ids.js';
import { revokeCredentials } from './credentials.js';

export interface RateGroupScope {
  mode: 'all' | 'selected';
  groupIds: string[];
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== ''))]
      : [];
  } catch {
    return [];
  }
}

export function siteRateGroupScope(site: Site): RateGroupScope {
  return {
    mode: site.rateGroupScopeMode === 'selected' ? 'selected' : 'all',
    groupIds: parseStringArray(site.rateGroupIdsJson),
  };
}

export function siteRateGroupAdapterMetadata(site: Site): Record<string, unknown> {
  return {
    rate_group_scope: {
      ...siteRateGroupScope(site),
      excluded_group_ids: parseStringArray(site.excludedRateGroupIdsJson),
    },
  };
}

export function rateGroupId(attributesJson: string): string | null {
  try {
    const value = (JSON.parse(attributesJson) as Record<string, unknown>).group_id;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

function excludeRateRows(
  context: AppContext,
  rate: typeof ratesCurrent.$inferSelect,
  groupId: string,
  now: string,
): void {
  const config = context.database.db.select().from(rateProbeConfigs)
    .where(eq(rateProbeConfigs.rateId, rate.id)).get();
  const mapping = context.database.db.select().from(siteProbeKeyMappings).where(and(
    eq(siteProbeKeyMappings.siteId, rate.siteId),
    eq(siteProbeKeyMappings.groupId, groupId),
  )).get();
  revokeCredentials(context.database, rate.siteId, [
    config?.customCredentialType ?? `rate_probe:${rate.id}:api_key`,
    ...(mapping ? [mapping.credentialType] : []),
  ]);
  context.database.db.delete(rateProbeConfigs).where(eq(rateProbeConfigs.rateId, rate.id)).run();
  context.database.db.delete(siteProbeKeyMappings).where(and(
    eq(siteProbeKeyMappings.siteId, rate.siteId),
    eq(siteProbeKeyMappings.groupId, groupId),
  )).run();
  if (rate.removedAt === null) {
    context.database.db.insert(rateHistory).values({
      id: createId('ratehist'),
      siteId: rate.siteId,
      rateKey: rate.rateKey,
      rateKind: rate.rateKind,
      changeType: 'removed',
      oldValue: rate.value,
      oldComparisonKey: rate.comparisonKey,
      confirmedAt: now,
    }).run();
  }
  context.database.db.update(ratesCurrent).set({
    metadataStatus: 'unavailable',
    removedAt: now,
    candidateValue: null,
    candidateCount: 0,
    updatedAt: now,
  }).where(eq(ratesCurrent.id, rate.id)).run();
}

export function updateSiteRateGroupScope(
  context: AppContext,
  site: Site,
  scope: RateGroupScope,
  now = new Date().toISOString(),
): void {
  const groupIds = [...new Set(scope.groupIds.map((id) => id.trim()).filter(Boolean))];
  const excluded = parseStringArray(site.excludedRateGroupIdsJson)
    .filter((id) => scope.mode !== 'selected' || !groupIds.includes(id));
  context.database.db.update(sites).set({
    rateGroupScopeMode: scope.mode,
    rateGroupIdsJson: JSON.stringify(groupIds),
    excludedRateGroupIdsJson: JSON.stringify(excluded),
    updatedAt: now,
  }).where(eq(sites.id, site.id)).run();

  if (scope.mode !== 'selected') return;
  const allowed = new Set(groupIds);
  const current = context.database.db.select().from(ratesCurrent)
    .where(eq(ratesCurrent.siteId, site.id)).all();
  for (const rate of current) {
    const groupId = rateGroupId(rate.attributesJson);
    if (rate.rateKind === 'group' && groupId && !allowed.has(groupId)) {
      excludeRateRows(context, rate, groupId, now);
    }
  }
  const mappings = context.database.db.select().from(siteProbeKeyMappings)
    .where(eq(siteProbeKeyMappings.siteId, site.id)).all();
  for (const mapping of mappings) {
    if (allowed.has(mapping.groupId)) continue;
    revokeCredentials(context.database, site.id, [mapping.credentialType]);
    context.database.db.delete(siteProbeKeyMappings)
      .where(eq(siteProbeKeyMappings.id, mapping.id)).run();
  }
}

export function excludeAndDeleteRate(context: AppContext, rateId: string): {
  siteId: string;
  rateKey: string;
  groupId: string;
} {
  const rate = context.database.db.select().from(ratesCurrent)
    .where(eq(ratesCurrent.id, rateId)).get();
  if (!rate) throw new AppError('RATE_NOT_FOUND', '倍率对象不存在', 404);
  const site = context.database.db.select().from(sites).where(eq(sites.id, rate.siteId)).get();
  if (!site || site.deletedAt !== null) throw new AppError('SITE_NOT_FOUND', '中转站不存在', 404);
  const groupId = rateGroupId(rate.attributesJson);
  if (!groupId) {
    throw new AppError('RATE_GROUP_ID_MISSING', '该倍率缺少稳定分组 ID，无法安全排除', 409);
  }
  const excluded = new Set(parseStringArray(site.excludedRateGroupIdsJson));
  const selected = siteRateGroupScope(site).groupIds.filter((id) => id !== groupId);
  if (site.rateGroupScopeMode !== 'selected') excluded.add(groupId);
  context.database.sqlite.transaction(() => {
    context.database.db.update(sites).set({
      ...(site.rateGroupScopeMode === 'selected' ? { rateGroupIdsJson: JSON.stringify(selected) } : {}),
      excludedRateGroupIdsJson: JSON.stringify([...excluded].sort()),
      updatedAt: new Date().toISOString(),
    }).where(eq(sites.id, site.id)).run();
    excludeRateRows(context, rate, groupId, new Date().toISOString());
  }).immediate();
  return { siteId: site.id, rateKey: rate.rateKey, groupId };
}
