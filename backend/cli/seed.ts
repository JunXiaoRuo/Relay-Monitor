import { pathToFileURL } from 'node:url';

import { eq } from 'drizzle-orm';

import { config } from '../config.js';
import { createId } from '../core/ids.js';
import {
  auditLogs,
  balanceSnapshots,
  balancesCurrent,
  healthChecks,
  incidents,
  initializeDatabase,
  maintenanceWindows,
  monitorConfigs,
  monitorJobs,
  notificationChannels,
  notificationRuleRevisions,
  notificationRules,
  rateHistory,
  rateSnapshots,
  ratesCurrent,
  sites,
} from '../db/index.js';
import { DEFAULT_MONITOR_INTERVAL_SECONDS, MONITOR_TYPES } from '../../shared/constants.js';

function shiftedIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function seedDevelopmentData(): void {
  if (config.isProduction) throw new Error('Development seed data cannot be inserted in production');
  const connection = initializeDatabase(config);
  try {
    const existing = connection.sqlite
      .prepare(`select count(*) as count from sites where tags_json like '%"sample"%' or tags_json like '%"demo"%'`)
      .get() as { count: number };
    if (existing.count > 0) {
      console.info('Development data already exists; nothing changed.');
      return;
    }

    connection.sqlite.transaction(() => {
      const siteRows = [
        {
          id: createId('site'), name: 'North Relay', baseUrl: 'https://north-relay.example.com',
          serviceStatus: 'healthy', authStatus: 'authenticated', balance: '38.42', latency: 286,
        },
        {
          id: createId('site'), name: 'Atlas Gateway', baseUrl: 'https://atlas-gateway.example.com',
          serviceStatus: 'degraded', authStatus: 'interaction_required', balance: '12.08', latency: 842,
        },
        {
          id: createId('site'), name: 'Harbor API', baseUrl: 'https://harbor-api.example.com',
          serviceStatus: 'down', authStatus: 'reauth_required', balance: '6.30', latency: 2_640,
        },
      ] as const;
      const checkedAt = shiftedIso(-2);
      for (const site of siteRows) {
        connection.db.insert(sites).values({
          id: site.id,
          adapterType: 'sub2api',
          adapterVersion: '1.0.0',
          adapterSchemaVersion: '1',
          name: site.name,
          baseUrl: site.baseUrl,
          tagsJson: JSON.stringify(['sample', site.serviceStatus === 'healthy' ? 'production' : 'watch']),
          notes: 'Development-only sample data',
          serviceStatus: site.serviceStatus,
          authStatus: site.authStatus,
          credentialMode: 'token',
          lastSuccessAt: site.serviceStatus === 'down' ? shiftedIso(-75) : checkedAt,
          lastErrorCode: site.serviceStatus === 'healthy' ? null : site.serviceStatus === 'down' ? 'UPSTREAM_UNREACHABLE' : 'UPSTREAM_RATE_LIMITED',
          lastErrorMessage: site.serviceStatus === 'healthy' ? null : site.serviceStatus === 'down' ? 'Connection timed out' : 'Upstream rate limit reached',
        }).run();
        for (const monitorType of MONITOR_TYPES) {
          connection.db.insert(monitorConfigs).values({
            id: createId('moncfg'),
            siteId: site.id,
            monitorType,
            enabled: true,
            intervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS[monitorType],
            timeoutSeconds: 15,
            scheduleJitterPercent: 10,
          }).run();
          connection.db.insert(monitorJobs).values({
            id: createId('job'),
            siteId: site.id,
            monitorType,
            state: 'queued',
            nextRunAt: '2099-01-01T00:00:00.000Z',
          }).run();
        }
        const healthId = createId('health');
        connection.db.insert(healthChecks).values({
          id: healthId,
          siteId: site.id,
          probeKind: 'model_api',
          success: site.serviceStatus === 'healthy',
          httpMs: site.latency,
          totalMs: site.latency,
          httpStatus: site.serviceStatus === 'down' ? null : site.serviceStatus === 'degraded' ? 429 : 200,
          authPassed: site.authStatus === 'authenticated',
          modelCount: site.serviceStatus === 'healthy' ? 42 : null,
          errorCode: site.serviceStatus === 'healthy' ? null : site.serviceStatus === 'down' ? 'UPSTREAM_UNREACHABLE' : 'UPSTREAM_RATE_LIMITED',
          consecutiveSuccesses: site.serviceStatus === 'healthy' ? 18 : 0,
          consecutiveFailures: site.serviceStatus === 'down' ? 4 : 1,
          checkedAt,
        }).run();
        const balanceSnapshotId = createId('balsnap');
        connection.db.insert(balanceSnapshots).values({
          id: balanceSnapshotId,
          siteId: site.id,
          balanceKey: 'cash:balance',
          balanceKind: 'cash',
          value: site.balance,
          available: site.balance,
          changeValue: '-1.20',
          currency: 'USD',
          unit: 'USD',
          precision: 2,
          loginReadable: true,
          collectedAt: checkedAt,
        }).run();
        connection.db.insert(balancesCurrent).values({
          id: createId('balance'),
          siteId: site.id,
          balanceKey: 'cash:balance',
          balanceKind: 'cash',
          value: site.balance,
          available: site.balance,
          changeValue: '-1.20',
          currency: 'USD',
          unit: 'USD',
          precision: 2,
          loginReadable: true,
          snapshotId: balanceSnapshotId,
          lastChangedAt: checkedAt,
          lastCheckedAt: checkedAt,
        }).run();
      }

      const values = [
        ['GPT Standard', 'openai'],
        ['GPT Priority', 'openai'],
        ['Claude Stable', 'anthropic'],
      ] as const;
      const siteRateValues = [
        ['0.05', '0.13', '0.20'],
        ['0.08', '0.16', '0.23'],
        ['0.11', '0.19', '0.26'],
      ] as const;
      siteRows.forEach((site, siteIndex) => {
        const snapshotId = createId('ratesnap');
        connection.db.insert(rateSnapshots).values({
          id: snapshotId,
          siteId: site.id,
          quality: siteIndex === 1 ? 'partial' : 'complete',
          fingerprint: `sample-${siteIndex}`,
          itemCount: values.length,
          collectedAt: checkedAt,
        }).run();
        values.forEach(([name, platform], rateIndex) => {
          const value = siteRateValues[siteIndex]![rateIndex]!;
          const rateId = createId('rate');
          connection.db.insert(ratesCurrent).values({
            id: rateId,
            siteId: site.id,
            rateKey: `group:${rateIndex + 1}:effective`,
            rateKind: 'group',
            name,
            platform,
            groupName: name,
            value,
            unit: 'multiplier',
            comparisonKey: rateIndex === 2
              ? 'sub2api:group:anthropic:effective:v1'
              : 'sub2api:group:openai:effective:v1',
            billingExpression: 'effective_rate = user_rate ?? base_rate',
            attributesJson: JSON.stringify({ base_rate: value, user_rate: null, effective_rate: value }),
            metadataStatus: siteIndex === 1 ? 'stale' : 'available',
            probeStatus: 'not_configured',
            snapshotId,
            firstSeenAt: shiftedIso(-1440),
            lastCheckedAt: checkedAt,
            lastChangedAt: rateIndex === 0 && siteIndex === 0 ? shiftedIso(-90) : null,
          }).run();
          if (rateIndex === 0 && siteIndex === 0) {
            connection.db.insert(rateHistory).values({
              id: createId('ratehist'),
              siteId: site.id,
              rateKey: `group:${rateIndex + 1}:effective`,
              rateKind: 'group',
              changeType: 'value_changed',
              direction: 'down',
              oldValue: '0.08',
              newValue: value,
              oldComparisonKey: 'sub2api:group:openai:effective:v1',
              newComparisonKey: 'sub2api:group:openai:effective:v1',
              snapshotId,
              confirmedAt: shiftedIso(-90),
            }).run();
          }
        });
      });

      const channelId = createId('channel');
      connection.db.insert(notificationChannels).values({
        id: channelId,
        name: 'Operations Webhook',
        url: 'https://hooks.example.com/relay-monitor',
        enabled: true,
      }).run();
      const ruleId = createId('rule');
      const revisionId = createId('revision');
      connection.db.insert(notificationRules).values({
        id: ruleId,
        name: 'Production site availability',
        type: 'site_down',
        enabled: true,
        severity: 'critical',
      }).run();
      connection.db.insert(notificationRuleRevisions).values({
        id: revisionId,
        ruleId,
        revisionNumber: 1,
        scopeJson: JSON.stringify({ tags: ['production'] }),
        conditionJson: '{}',
        triggerConfirmCount: 3,
        recoveryConfirmCount: 2,
        cooldownSeconds: 300,
        repeatIntervalSeconds: 3600,
        maxRepeats: 3,
        channelIdsJson: JSON.stringify([channelId]),
      }).run();
      connection.db.update(notificationRules).set({ currentRevisionId: revisionId })
        .where(eq(notificationRules.id, ruleId)).run();
      connection.db.insert(incidents).values({
        id: createId('incident'),
        ruleRevisionId: revisionId,
        siteId: siteRows[2]!.id,
        resourceKey: 'site',
        eventType: 'site.down',
        fingerprint: 'sample-site-down',
        activeFingerprint: 'sample-site-down',
        state: 'firing',
        severity: 'critical',
        summary: '港湾备用站已连续 4 次检查失败。',
        triggerCount: 4,
        firstObservedAt: shiftedIso(-75),
        firedAt: shiftedIso(-72),
        lastObservedAt: checkedAt,
      }).run();
      connection.db.insert(maintenanceWindows).values({
        id: createId('maint'),
        name: 'Atlas upstream maintenance',
        kind: 'once',
        matcherJson: JSON.stringify({ site_ids: [siteRows[1]!.id] }),
        startsAt: shiftedIso(-30),
        endsAt: shiftedIso(60),
        timezone: 'Asia/Shanghai',
      }).run();
      connection.db.insert(auditLogs).values({
        id: createId('audit'),
        action: 'development.seed',
        resourceType: 'system',
        metadataJson: JSON.stringify({ site_count: siteRows.length }),
      }).run();
    })();
    console.info(`Development data added to ${connection.path}.`);
  } finally {
    connection.close();
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    seedDevelopmentData();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Development seed failed');
    process.exitCode = 1;
  }
}
