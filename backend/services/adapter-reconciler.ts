import { and, eq, isNull } from 'drizzle-orm';

import { AdapterError, type AdapterManifest, type CapabilitySet } from '../adapters/index.js';
import type { AppContext } from '../context.js';
import { monitorConfigs, monitorJobs, siteCapabilities, sites } from '../db/index.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS } from '../../shared/constants.js';
import { createId } from '../core/ids.js';
import { createSafeFetchContext } from '../core/safe-fetch.js';
import { UnsafeUrlError } from '../core/ssrf.js';
import { loadCredentials } from './credentials.js';

export const CAPABILITY_PROBE_INTERVAL_MS = 24 * 60 * 60_000;
const DISCOVERY_MARKER_KEY = 'adapter.discovery';
const ADAPTER_UNAVAILABLE_CODE = 'ADAPTER_UNAVAILABLE';

interface ParsedVersion {
  core: readonly [number, number, number];
  prerelease: readonly string[];
}

export interface AdapterCompatibility {
  compatible: boolean;
  reason?: 'version_too_old' | 'version_uncomparable' | 'schema_too_old' | 'schema_invalid';
}

export interface AdapterReconciliationSummary {
  checked: number;
  unavailable: number;
  restoredJobs: number;
  scheduledProbes: number;
}

export interface CapabilityProbeResult {
  attempted: boolean;
  persisted: boolean;
  errorCode?: string;
}

export interface CapabilityProbeOptions {
  now?: Date;
  intervalMs?: number;
  signal?: AbortSignal;
  leaseIsValid?: () => boolean;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  const parts = [match[1], match[2] ?? '0', match[3] ?? '0'].map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return undefined;
  return {
    core: [parts[0]!, parts[1]!, parts[2]!],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function compareAdapterVersions(installed: string, required: string): number | undefined {
  if (installed === required) return 0;
  const left = parseVersion(installed);
  const right = parseVersion(required);
  if (!left || !right) return undefined;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] === right.core[index]) continue;
    return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function adapterCompatibility(
  manifest: AdapterManifest,
  requiredVersion: string | null,
  requiredSchemaVersion: string | null,
): AdapterCompatibility {
  if (requiredSchemaVersion !== null) {
    const parsedSchema = Number(requiredSchemaVersion);
    if (!Number.isSafeInteger(parsedSchema) || parsedSchema < 1) {
      return { compatible: false, reason: 'schema_invalid' };
    }
    if (manifest.adapterSchemaVersion < parsedSchema) {
      return { compatible: false, reason: 'schema_too_old' };
    }
  }
  if (requiredVersion === null) return { compatible: true };
  const compared = compareAdapterVersions(manifest.adapterVersion, requiredVersion);
  if (compared === undefined) return { compatible: false, reason: 'version_uncomparable' };
  if (compared < 0) return { compatible: false, reason: 'version_too_old' };
  return { compatible: true };
}

function unavailableMessage(adapterType: string, compatibility?: AdapterCompatibility): string {
  if (!compatibility) return `Adapter '${adapterType}' is not installed`;
  return `Installed adapter '${adapterType}' does not satisfy the site's saved version requirements (${compatibility.reason})`;
}

export function reconcileAdapterStates(
  context: AppContext,
  now: Date = new Date(),
): AdapterReconciliationSummary {
  const timestamp = now.toISOString();
  const activeSites = context.database.db.select().from(sites).where(isNull(sites.deletedAt)).all();
  let unavailable = 0;
  let restoredJobs = 0;
  let scheduledProbes = 0;

  context.database.sqlite.transaction(() => {
    for (const site of activeSites) {
      const adapter = context.adapters.has(site.adapterType) ? context.adapters.get(site.adapterType) : undefined;
      const manifest = adapter?.manifest();
      const compatibility = manifest
        ? adapterCompatibility(manifest, site.adapterVersion, site.adapterSchemaVersion)
        : undefined;
      if (!manifest || !compatibility?.compatible) {
        unavailable += 1;
        const message = unavailableMessage(site.adapterType, compatibility);
        context.database.db.update(sites).set({
          serviceStatus: 'adapter_unavailable',
          lastErrorCode: ADAPTER_UNAVAILABLE_CODE,
          lastErrorMessage: message,
          updatedAt: timestamp,
        }).where(eq(sites.id, site.id)).run();
        context.database.db.update(monitorJobs).set({
          state: 'disabled',
          leaseOwner: null,
          leaseUntil: null,
          runRequested: false,
          lastErrorCode: ADAPTER_UNAVAILABLE_CODE,
          lastErrorMessage: message,
          updatedAt: timestamp,
        }).where(eq(monitorJobs.siteId, site.id)).run();
        continue;
      }

      const recovering = site.serviceStatus === 'adapter_unavailable' || site.lastErrorCode === ADAPTER_UNAVAILABLE_CODE;
      context.database.db.update(sites).set({
        adapterVersion: manifest.adapterVersion,
        adapterSchemaVersion: String(manifest.adapterSchemaVersion),
        ...(recovering ? {
          serviceStatus: 'unknown' as const,
          lastErrorCode: null,
          lastErrorMessage: null,
        } : {}),
        updatedAt: timestamp,
      }).where(eq(sites.id, site.id)).run();

      const jobs = context.database.db
        .select({ job: monitorJobs, monitorEnabled: monitorConfigs.enabled })
        .from(monitorJobs)
        .innerJoin(monitorConfigs, and(
          eq(monitorConfigs.siteId, monitorJobs.siteId),
          eq(monitorConfigs.monitorType, monitorJobs.monitorType),
        ))
        .where(eq(monitorJobs.siteId, site.id))
        .all();
      for (const { job, monitorEnabled } of jobs) {
        const explicitAdapterError = job.lastErrorCode === ADAPTER_UNAVAILABLE_CODE;
        const adapterDisabled = explicitAdapterError || (recovering && job.state === 'disabled');
        if (!adapterDisabled) continue;
        if (site.enabled && monitorEnabled && job.state === 'disabled') {
          context.database.db.update(monitorJobs).set({
            state: 'queued',
            nextRunAt: timestamp,
            leaseOwner: null,
            leaseUntil: null,
            attempts: 0,
            runRequested: false,
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: timestamp,
          }).where(eq(monitorJobs.id, job.id)).run();
          restoredJobs += 1;
          continue;
        }
        if (explicitAdapterError) {
          context.database.db.update(monitorJobs).set({
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: timestamp,
          }).where(eq(monitorJobs.id, job.id)).run();
        }
      }

      const capabilityRows = context.database.db.select().from(siteCapabilities)
        .where(eq(siteCapabilities.siteId, site.id)).all();
      if (site.enabled && probeIsDue(capabilityRows, manifest, now, CAPABILITY_PROBE_INTERVAL_MS)) {
        const probeJob = context.database.db
          .select({ job: monitorJobs })
          .from(monitorJobs)
          .innerJoin(monitorConfigs, and(
            eq(monitorConfigs.siteId, monitorJobs.siteId),
            eq(monitorConfigs.monitorType, monitorJobs.monitorType),
          ))
          .where(and(
            eq(monitorJobs.siteId, site.id),
            eq(monitorJobs.state, 'queued'),
            eq(monitorConfigs.enabled, true),
          ))
          .orderBy(monitorJobs.nextRunAt)
          .get()?.job;
        if (probeJob && probeJob.nextRunAt > timestamp) {
          context.database.db.update(monitorJobs).set({
            nextRunAt: timestamp,
            updatedAt: timestamp,
          }).where(eq(monitorJobs.id, probeJob.id)).run();
          scheduledProbes += 1;
        }
      }
    }
  })();

  return { checked: activeSites.length, unavailable, restoredJobs, scheduledProbes };
}

function probeIsDue(
  rows: Array<typeof siteCapabilities.$inferSelect>,
  manifest: AdapterManifest,
  now: Date,
  intervalMs: number,
): boolean {
  if (rows.length === 0) return true;
  if (rows.some((row) =>
    row.adapterVersion !== manifest.adapterVersion ||
    row.adapterSchemaVersion !== String(manifest.adapterSchemaVersion)
  )) return true;
  const newestProbe = Math.max(...rows.map((row) => Date.parse(row.detectedAt)));
  return !Number.isFinite(newestProbe) || newestProbe <= now.getTime() - intervalMs;
}

function persistCapabilityResult(
  context: AppContext,
  siteId: string,
  manifest: AdapterManifest,
  result: CapabilitySet,
  now: Date,
): void {
  const entries = Object.entries(result.capabilities).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error('Adapter capability discovery returned no capability records');
  const timestamp = now.toISOString();
  context.database.sqlite.transaction(() => {
    context.database.db.delete(siteCapabilities).where(eq(siteCapabilities.siteId, siteId)).run();
    for (const [key, capability] of entries) {
      context.database.db.insert(siteCapabilities).values({
        id: createId('cap'),
        siteId,
        capabilityKey: key,
        status: capability.status,
        adapterVersion: manifest.adapterVersion,
        adapterSchemaVersion: String(manifest.adapterSchemaVersion),
        upstreamVersion: result.upstreamVersion ?? null,
        structureFingerprint: result.responseStructureFingerprint ?? null,
        lastErrorCode: capability.lastErrorCode ?? null,
        detectedAt: Number.isFinite(Date.parse(capability.checkedAt)) ? capability.checkedAt : timestamp,
        updatedAt: timestamp,
      }).run();
    }
    context.database.db.update(sites).set({
      adapterVersion: manifest.adapterVersion,
      adapterSchemaVersion: String(manifest.adapterSchemaVersion),
      updatedAt: timestamp,
    }).where(eq(sites.id, siteId)).run();
  })();
}

function persistCapabilityFailure(
  context: AppContext,
  siteId: string,
  manifest: AdapterManifest,
  errorCode: string,
  now: Date,
): void {
  const timestamp = now.toISOString();
  context.database.sqlite.transaction(() => {
    const existing = context.database.db.select().from(siteCapabilities)
      .where(eq(siteCapabilities.siteId, siteId)).all();
    if (existing.length === 0) {
      context.database.db.insert(siteCapabilities).values({
        id: createId('cap'),
        siteId,
        capabilityKey: DISCOVERY_MARKER_KEY,
        status: 'unknown',
        adapterVersion: manifest.adapterVersion,
        adapterSchemaVersion: String(manifest.adapterSchemaVersion),
        detailsJson: JSON.stringify({ probe_failed: true }),
        lastErrorCode: errorCode,
        detectedAt: timestamp,
        updatedAt: timestamp,
      }).run();
      return;
    }
    context.database.db.update(siteCapabilities).set({
      adapterVersion: manifest.adapterVersion,
      adapterSchemaVersion: String(manifest.adapterSchemaVersion),
      lastErrorCode: errorCode,
      detectedAt: timestamp,
      updatedAt: timestamp,
    }).where(eq(siteCapabilities.siteId, siteId)).run();
  })();
}

function capabilityErrorCode(error: unknown): string {
  if (error instanceof AdapterError || error instanceof UnsafeUrlError) return error.code;
  return 'CAPABILITY_DISCOVERY_FAILED';
}

export async function refreshSiteCapabilitiesIfDue(
  context: AppContext,
  siteId: string,
  options: CapabilityProbeOptions = {},
): Promise<CapabilityProbeResult> {
  const now = options.now ?? new Date();
  const intervalMs = options.intervalMs ?? CAPABILITY_PROBE_INTERVAL_MS;
  const leaseIsValid = options.leaseIsValid ?? (() => true);
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('Capability probe interval must be non-negative');
  if (!leaseIsValid()) return { attempted: false, persisted: false, errorCode: 'LEASE_LOST' };

  const site = context.database.db.select().from(sites).where(and(
    eq(sites.id, siteId), isNull(sites.deletedAt), eq(sites.enabled, true),
  )).get();
  if (!site || !context.adapters.has(site.adapterType)) return { attempted: false, persisted: false };
  const adapter = context.adapters.get(site.adapterType);
  const manifest = adapter.manifest();
  if (!adapterCompatibility(manifest, site.adapterVersion, site.adapterSchemaVersion).compatible) {
    return { attempted: false, persisted: false, errorCode: ADAPTER_UNAVAILABLE_CODE };
  }
  const current = context.database.db.select().from(siteCapabilities)
    .where(eq(siteCapabilities.siteId, siteId)).all();
  if (!probeIsDue(current, manifest, now, intervalMs)) return { attempted: false, persisted: false };

  let outbound: Awaited<ReturnType<typeof createSafeFetchContext>> | undefined;
  try {
    const credentials = loadCredentials(context.database, context.vault, site.id);
    outbound = await createSafeFetchContext(site.baseUrl, {
      allowHttp: !context.config.isProduction,
      allowedCidrs: context.config.outboundAllowedCidrs,
    });
    const result = await adapter.discover({
      siteId: site.id,
      baseUrl: outbound.baseUrl,
      credentials,
      fetch: outbound.fetch,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_SECONDS * 1_000,
      ...(options.signal ? { signal: options.signal } : {}),
      now,
    });
    if (!leaseIsValid()) return { attempted: true, persisted: false, errorCode: 'LEASE_LOST' };
    if (result.adapterType !== manifest.adapterType) {
      throw new Error('Adapter capability discovery returned a mismatched adapter type');
    }
    persistCapabilityResult(context, site.id, manifest, result, now);
    return { attempted: true, persisted: true };
  } catch (error) {
    if (!leaseIsValid()) return { attempted: true, persisted: false, errorCode: 'LEASE_LOST' };
    const errorCode = capabilityErrorCode(error);
    persistCapabilityFailure(context, site.id, manifest, errorCode, now);
    return { attempted: true, persisted: true, errorCode };
  } finally {
    await outbound?.close();
  }
}
