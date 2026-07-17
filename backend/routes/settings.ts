import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { decimalStringSchema } from '../../shared/schemas.js';
import type { AppContext } from '../context.js';
import { success } from '../core/api-response.js';
import { recordAudit } from '../core/audit.js';
import { normalizeDecimal } from '../core/decimal.js';
import {
  adminSessions,
  balanceAlertSettings,
  monitorConfigs,
  monitorJobs,
  sites,
  serverAccessSettings,
} from '../db/index.js';
import {
  GLOBAL_BALANCE_ALERT_SETTINGS_ID,
  readBalanceAlertSettings,
} from '../services/balance-alert-settings.js';
import {
  assertUsableStoredTlsMaterial,
  GLOBAL_SERVER_ACCESS_SETTINGS_ID,
  inspectServerCertificate,
  normalizeAccessHost,
  readServerAccessSettings,
  removeTlsMaterial,
  serverAccessUrl,
  storeTlsMaterial,
  type StoredServerAccessSettings,
} from '../services/server-access-settings.js';

const patchBalanceAlertSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  threshold: decimalStringSchema.optional(),
}).refine((input) => Object.keys(input).length > 0, '至少填写一个要修改的字段');

const patchServerAccessSettingsSchema = z.object({
  protocol: z.enum(['http', 'https']),
  access_host: z.string().min(1).max(253),
  certificate_pem: z.string().max(256 * 1024).optional(),
  private_key_pem: z.string().max(128 * 1024).optional(),
}).superRefine((input, context) => {
  const hasCertificate = Boolean(input.certificate_pem?.trim());
  const hasPrivateKey = Boolean(input.private_key_pem?.trim());
  if (hasCertificate !== hasPrivateKey) {
    context.addIssue({
      code: 'custom',
      path: hasCertificate ? ['private_key_pem'] : ['certificate_pem'],
      message: '服务器证书和私钥必须同时填写，或同时留空',
    });
  }
});

export interface SettingsRouteOptions {
  requestRestart?: () => void;
}

function balanceAlertSettingsDto(context: AppContext) {
  const settings = readBalanceAlertSettings(context.database);
  return {
    enabled: settings.enabled,
    threshold: normalizeDecimal(settings.threshold),
    updated_at: settings.updatedAt,
  };
}

function queueBalanceChecks(context: AppContext, now: string): number {
  const jobs = context.database.db.select({ job: monitorJobs })
    .from(monitorJobs)
    .innerJoin(monitorConfigs, and(
      eq(monitorConfigs.siteId, monitorJobs.siteId),
      eq(monitorConfigs.monitorType, monitorJobs.monitorType),
      eq(monitorConfigs.enabled, true),
    ))
    .innerJoin(sites, and(
      eq(sites.id, monitorJobs.siteId),
      eq(sites.enabled, true),
      isNull(sites.deletedAt),
    ))
    .where(eq(monitorJobs.monitorType, 'balance'))
    .all();
  for (const { job } of jobs) {
    context.database.db.update(monitorJobs).set(job.state === 'running' ? {
      runRequested: true,
      updatedAt: now,
    } : {
      state: 'queued',
      nextRunAt: now,
      retryAfter: null,
      leaseOwner: null,
      leaseUntil: null,
      runRequested: false,
      updatedAt: now,
    }).where(eq(monitorJobs.id, job.id)).run();
  }
  return jobs.length;
}

function serverAccessSettingsDto(
  context: AppContext,
  settings: StoredServerAccessSettings,
  restarting = false,
) {
  const protocol = settings.tlsEnabled ? 'https' as const : 'http' as const;
  const active = context.serverAccess;
  const restartRequired = protocol !== active.protocol
    || settings.accessHost !== active.settings.accessHost
    || (settings.tlsEnabled && settings.tlsMaterialId !== active.settings.tlsMaterialId);
  const certificate = inspectServerCertificate(context.config, settings);
  return {
    protocol,
    access_host: settings.accessHost,
    listen_host: context.config.host,
    listen_port: context.config.port,
    active_protocol: active.protocol,
    active_url: serverAccessUrl(active.protocol, active.settings.accessHost, context.config.port),
    next_url: serverAccessUrl(protocol, settings.accessHost, context.config.port),
    restart_required: restartRequired,
    managed_restart: context.config.managedRestart,
    restarting,
    updated_at: settings.updatedAt,
    certificate: {
      configured: certificate.configured,
      subject: certificate.subject,
      issuer: certificate.issuer,
      subject_alt_name: certificate.subjectAltName,
      valid_from: certificate.validFrom,
      valid_to: certificate.validTo,
      fingerprint_sha256: certificate.fingerprintSha256,
      host_matches: certificate.hostMatches,
    },
  };
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  context: AppContext,
  options: SettingsRouteOptions = {},
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/api/v1/settings/server-access', {
    schema: { tags: ['settings'], summary: '读取管理台访问方式和 SSL 状态' },
  }, async (request) => success(
    request,
    serverAccessSettingsDto(context, readServerAccessSettings(context.database, context.config)),
  ));

  typed.patch('/api/v1/settings/server-access', {
    schema: {
      tags: ['settings'],
      summary: '更新管理台 HTTP 或 HTTPS 访问方式',
      body: patchServerAccessSettingsSchema,
    },
  }, async (request) => {
    const current = readServerAccessSettings(context.database, context.config);
    const accessHost = normalizeAccessHost(request.body.access_host);
    const certificatePem = request.body.certificate_pem?.trim() || null;
    const privateKeyPem = request.body.private_key_pem?.trim() || null;
    let tlsMaterialId = current.tlsMaterialId;
    let createdMaterialId: string | null = null;
    const tlsEnabled = request.body.protocol === 'https';
    const protocolChanged = current.tlsEnabled !== tlsEnabled;
    const accessHostChanged = current.accessHost !== accessHost;
    let revokedSessionCount = 0;
    try {
      if (certificatePem && privateKeyPem) {
        createdMaterialId = storeTlsMaterial(
          context.config,
          certificatePem,
          privateKeyPem,
          accessHost,
        ).materialId;
        tlsMaterialId = createdMaterialId;
      }

      const desired: StoredServerAccessSettings = {
        tlsEnabled,
        accessHost,
        tlsMaterialId,
        updatedAt: new Date().toISOString(),
      };
      if (tlsEnabled) assertUsableStoredTlsMaterial(context.config, desired);

      context.database.sqlite.transaction(() => {
        context.database.db.insert(serverAccessSettings).values({
          id: GLOBAL_SERVER_ACCESS_SETTINGS_ID,
          tlsEnabled,
          accessHost,
          tlsMaterialId,
          updatedAt: desired.updatedAt!,
        }).onConflictDoUpdate({
          target: serverAccessSettings.id,
          set: {
            tlsEnabled,
            accessHost,
            tlsMaterialId,
            updatedAt: desired.updatedAt!,
          },
        }).run();
        if (protocolChanged || accessHostChanged) {
          revokedSessionCount = context.database.db.update(adminSessions).set({
            revokedAt: desired.updatedAt!,
          }).where(isNull(adminSessions.revokedAt)).run().changes;
        }
        recordAudit(context.database, request, {
          action: 'server_access_settings.update',
          resourceType: 'server_access_settings',
          resourceId: GLOBAL_SERVER_ACCESS_SETTINGS_ID,
          metadata: {
            protocol: request.body.protocol,
            access_host: accessHost,
            certificate_replaced: Boolean(certificatePem),
            protocol_changed: protocolChanged,
            access_host_changed: accessHostChanged,
            revoked_session_count: revokedSessionCount,
          },
        });
      }).immediate();
    } catch (error) {
      if (createdMaterialId) {
        try {
          removeTlsMaterial(context.config, createdMaterialId);
        } catch (cleanupError) {
          request.log.warn({ err: cleanupError, tls_material_id: createdMaterialId }, 'Failed to clean up uncommitted TLS material');
        }
      }
      throw error;
    }

    if (createdMaterialId && current.tlsMaterialId && current.tlsMaterialId !== createdMaterialId) {
      try {
        removeTlsMaterial(context.config, current.tlsMaterialId);
      } catch (cleanupError) {
        request.log.warn({ err: cleanupError, tls_material_id: current.tlsMaterialId }, 'Failed to clean up replaced TLS material');
      }
    }

    const saved = readServerAccessSettings(context.database, context.config);
    const preview = serverAccessSettingsDto(context, saved);
    const restarting = preview.restart_required
      && context.config.managedRestart
      && options.requestRestart !== undefined;
    if (restarting) {
      const timer = setTimeout(() => options.requestRestart?.(), 1_000);
      timer.unref();
    }
    return success(request, { ...serverAccessSettingsDto(context, saved, restarting), revoked_session_count: revokedSessionCount });
  });

  typed.get('/api/v1/settings/balance-alert', {
    schema: { tags: ['settings'], summary: '读取全局低余额设置' },
  }, async (request) => success(request, balanceAlertSettingsDto(context)));

  typed.patch('/api/v1/settings/balance-alert', {
    schema: {
      tags: ['settings'],
      summary: '更新全局低余额设置并立即排队余额检查',
      body: patchBalanceAlertSettingsSchema,
    },
  }, async (request) => {
    const current = readBalanceAlertSettings(context.database);
    const now = new Date().toISOString();
    const nextEnabled = request.body.enabled ?? current.enabled;
    const nextThreshold = request.body.threshold === undefined
      ? current.threshold
      : normalizeDecimal(request.body.threshold);
    let queuedChecks = 0;
    context.database.sqlite.transaction(() => {
      context.database.db.insert(balanceAlertSettings).values({
        id: GLOBAL_BALANCE_ALERT_SETTINGS_ID,
        enabled: nextEnabled,
        threshold: nextThreshold,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: balanceAlertSettings.id,
        set: { enabled: nextEnabled, threshold: nextThreshold, updatedAt: now },
      }).run();
      queuedChecks = queueBalanceChecks(context, now);
      recordAudit(context.database, request, {
        action: 'balance_alert_settings.update',
        resourceType: 'balance_alert_settings',
        resourceId: GLOBAL_BALANCE_ALERT_SETTINGS_ID,
        metadata: { enabled: nextEnabled, threshold: nextThreshold, queued_checks: queuedChecks },
      });
    }).immediate();
    return success(request, { ...balanceAlertSettingsDto(context), queued_checks: queuedChecks });
  });
}
