import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../backend/db/client.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite database bootstrap', () => {
  it('runs all migrations and enables durable SQLite settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-db-'));
    temporaryDirectories.push(directory);
    const connection = openDatabase({ path: join(directory, 'monitor.db'), busyTimeoutMs: 4_321 });

    try {
      const tables = connection.sqlite
        .prepare("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'sites',
          'credentials',
          'monitor_jobs',
          'rate_probe_configs',
          'rate_probe_runs',
          'site_probe_key_mappings',
          'incidents',
          'outbox_messages',
          'admins',
          'server_access_settings',
        ]),
      );
      expect(connection.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(connection.sqlite.pragma('busy_timeout', { simple: true })).toBe(4_321);
      expect(connection.sqlite.pragma('synchronous', { simple: true })).toBe(2);
      expect(connection.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      connection.close();
    }
  });

  it('upgrades a populated 0004 database without losing legacy probe configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-upgrade-'));
    temporaryDirectories.push(directory);
    const legacyMigrations = join(directory, 'legacy-migrations');
    const legacyMeta = join(legacyMigrations, 'meta');
    mkdirSync(legacyMeta, { recursive: true });
    const sourceMigrations = join(process.cwd(), 'backend', 'db', 'migrations');
    for (const file of [
      '0000_initial.sql',
      '0001_soft_delete_notifications.sql',
      '0002_soft_delete_routes_maintenance.sql',
      '0003_rate_model_probes.sql',
      '0004_rate_probe_token_details.sql',
    ]) {
      copyFileSync(join(sourceMigrations, file), join(legacyMigrations, file));
    }
    const journal = JSON.parse(readFileSync(join(sourceMigrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 4);
    writeFileSync(join(legacyMeta, '_journal.json'), JSON.stringify(journal));

    const databasePath = join(directory, 'monitor.db');
    const legacy = openDatabase({ path: databasePath, migrationsFolder: legacyMigrations });
    legacy.sqlite.exec(`
      insert into sites (id, adapter_type, name, base_url)
      values ('site_upgrade', 'sub2api', 'Upgrade', 'https://relay.example');
      insert into rates_current
        (id, site_id, rate_key, rate_kind, name, value, unit, comparison_key, first_seen_at, last_checked_at)
      values
        ('rate_upgrade', 'site_upgrade', 'group:12:effective', 'group', 'Group 12', '0.12',
         'multiplier', 'sub2api:group:effective:v1', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
      insert into rate_probe_configs
        (id, rate_id, site_id, model_mode, model, use_site_api_key, custom_credential_type)
      values
        ('probeconfig_upgrade', 'rate_upgrade', 'site_upgrade', 'manual', 'gpt-test', 0,
         'rate_probe:rate_upgrade:api_key');
      insert into rate_probe_runs
        (id, config_id, rate_id, site_id, status, requested_model, started_at)
      values
        ('proberun_upgrade', 'probeconfig_upgrade', 'rate_upgrade', 'site_upgrade', 'succeeded',
         'gpt-test', '2026-07-14T00:00:00.000Z');
      insert into monitor_configs (id, site_id, monitor_type, interval_seconds)
      values ('monitor_upgrade', 'site_upgrade', 'connectivity', 60);
    `);
    legacy.close();

    const upgraded = openDatabase({ path: databasePath });
    try {
      expect(upgraded.sqlite.prepare(
        'select rate_group_scope_mode, rate_group_ids_json from sites where id = ?',
      ).get('site_upgrade')).toEqual({ rate_group_scope_mode: 'all', rate_group_ids_json: '[]' });
      expect(upgraded.sqlite.prepare(
        'select key_mode, enabled, interval_seconds, timeout_seconds, retry_count, retry_interval_seconds from rate_probe_configs where id = ?',
      ).get('probeconfig_upgrade')).toEqual({
        key_mode: 'manual',
        enabled: 0,
        interval_seconds: 3600,
        timeout_seconds: 30,
        retry_count: 0,
        retry_interval_seconds: 0,
      });
      expect(upgraded.sqlite.prepare(
        'select retry_count, retry_interval_seconds from monitor_configs where id = ?',
      ).get('monitor_upgrade')).toEqual({ retry_count: 0, retry_interval_seconds: 0 });
      expect(upgraded.sqlite.prepare(
        'select config_id from rate_probe_runs where id = ?',
      ).get('proberun_upgrade')).toEqual({ config_id: 'probeconfig_upgrade' });
      upgraded.sqlite.exec(`
        insert into rates_current
          (id, site_id, rate_key, rate_kind, name, value, unit, comparison_key, first_seen_at, last_checked_at)
        values
          ('rate_new_defaults', 'site_upgrade', 'group:13:effective', 'group', 'Group 13', '0.13',
           'multiplier', 'sub2api:group:effective:v1', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
        insert into rate_probe_configs (id, rate_id, site_id)
        values ('probeconfig_new_defaults', 'rate_new_defaults', 'site_upgrade');
      `);
      expect(upgraded.sqlite.prepare(
        'select timeout_seconds, retry_count, retry_interval_seconds from rate_probe_configs where id = ?',
      ).get('probeconfig_new_defaults')).toEqual({
        timeout_seconds: 30,
        retry_count: 3,
        retry_interval_seconds: 60,
      });
      expect(() => upgraded.sqlite.prepare(
        'update rate_probe_configs set timeout_seconds = 0 where id = ?',
      ).run('probeconfig_new_defaults')).toThrow();
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      const objects = upgraded.sqlite.prepare(
        'select type, name from sqlite_master order by type, name',
      ).all() as Array<{ type: string; name: string }>;
      expect(objects).toEqual(expect.arrayContaining([
        { type: 'index', name: 'rate_probe_configs_due_idx' },
        { type: 'index', name: 'rate_probe_runs_one_running_site_uq' },
        { type: 'trigger', name: 'rate_probe_configs_schedule_update_ck' },
        { type: 'trigger', name: 'sites_rate_group_scope_update_ck' },
      ]));
    } finally {
      upgraded.close();
    }
  });

  it('migrates only a single unconstrained legacy route and archives ambiguous routing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-route-upgrade-'));
    temporaryDirectories.push(directory);
    const legacyMigrations = join(directory, 'legacy-migrations');
    const legacyMeta = join(legacyMigrations, 'meta');
    mkdirSync(legacyMeta, { recursive: true });
    const sourceMigrations = join(process.cwd(), 'backend', 'db', 'migrations');
    for (const file of [
      '0000_initial.sql',
      '0001_soft_delete_notifications.sql',
      '0002_soft_delete_routes_maintenance.sql',
      '0003_rate_model_probes.sql',
      '0004_rate_probe_token_details.sql',
      '0005_rate_scope_probe_schedule.sql',
      '0006_probe_scheduler_indexes.sql',
      '0007_probe_schedule_guards.sql',
      '0008_audit_log_soft_delete.sql',
      '0009_maintenance_reason.sql',
    ]) {
      copyFileSync(join(sourceMigrations, file), join(legacyMigrations, file));
    }
    const journal = JSON.parse(readFileSync(join(sourceMigrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
    writeFileSync(join(legacyMeta, '_journal.json'), JSON.stringify(journal));

    const databasePath = join(directory, 'monitor.db');
    const legacy = openDatabase({ path: databasePath, migrationsFolder: legacyMigrations });
    legacy.sqlite.exec(`
      insert into notification_channels (id, name, url)
      values
        ('channel_default', 'Default', 'https://default.example/hook'),
        ('channel_conditional', 'Conditional', 'https://conditional.example/hook'),
        ('channel_invalid', 'Invalid matcher', 'https://invalid.example/hook'),
        ('channel_direct', 'Direct', 'https://direct.example/hook');
      insert into notification_rules (id, name, type, current_revision_id)
      values
        ('rule_empty', 'Empty rule', 'monitor_events', 'revision_empty'),
        ('rule_direct', 'Direct rule', 'monitor_events', 'revision_direct');
      insert into notification_rule_revisions
        (id, rule_id, revision_number, channel_ids_json)
      values
        ('revision_empty_old', 'rule_empty', 1, '[]'),
        ('revision_empty', 'rule_empty', 2, '[]'),
        ('revision_direct', 'rule_direct', 1, '["channel_direct"]');
      insert into notification_routes
        (id, name, enabled, matcher_json, channel_ids_json)
      values
        ('route_default', 'Default route', 1, '{}', '["channel_default"]'),
        ('route_conditional', 'Critical only', 1, '{"severities":["critical"]}', '["channel_conditional"]'),
        ('route_invalid', 'Invalid matcher', 1, 'not-json', '["channel_invalid"]');
    `);
    legacy.close();

    const upgraded = openDatabase({ path: databasePath });
    try {
      const revisions = upgraded.sqlite.prepare(
        'select id, channel_ids_json from notification_rule_revisions order by id',
      ).all() as Array<{ id: string; channel_ids_json: string }>;
      expect(revisions.map((row) => [row.id, JSON.parse(row.channel_ids_json)])).toEqual([
        ['revision_direct', ['channel_direct']],
        ['revision_empty', []],
        ['revision_empty_old', []],
        ['rulerev_system_event_fallback_v1', []],
        ['rulerev_system_event_fallback_v2', []],
      ]);
      const routes = upgraded.sqlite.prepare(
        'select id, enabled, deleted_at from notification_routes order by id',
      ).all() as Array<{ id: string; enabled: number; deleted_at: string | null }>;
      expect(routes).toEqual([
        expect.objectContaining({ id: 'route_conditional', enabled: 0 }),
        expect.objectContaining({ id: 'route_default', enabled: 0 }),
        expect.objectContaining({ id: 'route_invalid', enabled: 0 }),
      ]);
      expect(routes.every((route) => route.deleted_at !== null)).toBe(true);
    } finally {
      upgraded.close();
    }

    const simpleDatabasePath = join(directory, 'simple-monitor.db');
    const simpleLegacy = openDatabase({ path: simpleDatabasePath, migrationsFolder: legacyMigrations });
    simpleLegacy.sqlite.exec(`
      insert into notification_channels (id, name, url)
      values ('channel_default', 'Default', 'https://default.example/hook');
      insert into notification_rules (id, name, type, current_revision_id, deleted_at)
      values
        ('rule_empty', 'Empty rule', 'monitor_events', 'revision_empty', null),
        ('rule_cross', 'Cross-linked rule', 'monitor_events', 'revision_empty', null),
        ('rule_deleted', 'Deleted rule', 'monitor_events', 'revision_deleted', '2026-07-14T00:00:00.000Z');
      insert into notification_rule_revisions
        (id, rule_id, revision_number, scope_json, condition_json, channel_ids_json)
      values
        ('revision_empty_old', 'rule_empty', 1, '{}', '{}', '[]'),
        ('revision_empty', 'rule_empty', 2, '{"site_ids":["site_a"]}',
         '{"event_types":["site.unavailable"]}', '[]'),
        ('revision_deleted', 'rule_deleted', 1, '{}', '{}', '[]');
      insert into incidents
        (id, rule_revision_id, resource_key, event_type, fingerprint, active_fingerprint,
         state, severity, summary, first_observed_at, last_observed_at)
      values
        ('incident_old_revision', 'revision_empty', 'site:site_a', 'site.timeout',
         'old-revision-fingerprint', 'old-revision-fingerprint', 'firing', 'warning',
         'Old revision incident', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
      insert into notification_routes
        (id, name, enabled, matcher_json, channel_ids_json)
      values ('route_default', 'Default route', 1, '{}', '["channel_default"]');
    `);
    simpleLegacy.close();

    const simpleUpgraded = openDatabase({ path: simpleDatabasePath });
    try {
      const rules = simpleUpgraded.sqlite.prepare(
        'select id, current_revision_id from notification_rules order by id',
      ).all() as Array<{ id: string; current_revision_id: string }>;
      const activeRule = rules.find((row) => row.id === 'rule_empty');
      expect(activeRule?.current_revision_id).not.toBe('revision_empty');
      expect(rules.find((row) => row.id === 'rule_deleted')?.current_revision_id)
        .toBe('revision_deleted');
      expect(rules.find((row) => row.id === 'rule_cross')?.current_revision_id)
        .toBe('revision_empty');

      const revisions = simpleUpgraded.sqlite.prepare(
        `select id, rule_id, revision_number, scope_json, condition_json, channel_ids_json
         from notification_rule_revisions order by rule_id, revision_number`,
      ).all() as Array<{
        id: string;
        rule_id: string;
        revision_number: number;
        scope_json: string;
        condition_json: string;
        channel_ids_json: string;
      }>;
      const activeRevisions = revisions.filter((row) => row.rule_id === 'rule_empty');
      expect(activeRevisions.map((row) => [
        row.id,
        row.revision_number,
        JSON.parse(row.channel_ids_json),
      ])).toEqual([
        ['revision_empty_old', 1, []],
        ['revision_empty', 2, []],
        [activeRule?.current_revision_id, 3, ['channel_default']],
      ]);
      expect(activeRevisions[2]).toMatchObject({
        scope_json: '{"site_ids":["site_a"]}',
        condition_json: '{"event_types":["site.unavailable"]}',
      });
      expect(revisions.find((row) => row.rule_id === 'rule_deleted')).toMatchObject({
        id: 'revision_deleted',
        revision_number: 1,
        channel_ids_json: '[]',
      });
      expect(revisions.filter((row) => row.rule_id === 'rule_cross')).toEqual([]);
      const migratedIncident = simpleUpgraded.sqlite.prepare(
        `select state, active_fingerprint, suppression_reason
         from incidents where id = ?`,
      ).get('incident_old_revision') as {
        state: string;
        active_fingerprint: string | null;
        suppression_reason: string | null;
      };
      expect(migratedIncident).toEqual({
        state: 'suppressed',
        active_fingerprint: null,
        suppression_reason: 'rule_revision_replaced',
      });
    } finally {
      simpleUpgraded.close();
    }

    const malformedDatabasePath = join(directory, 'malformed-monitor.db');
    const malformedLegacy = openDatabase({ path: malformedDatabasePath, migrationsFolder: legacyMigrations });
    malformedLegacy.sqlite.exec(`
      insert into notification_channels (id, name, url)
      values ('channel_default', 'Default', 'https://default.example/hook');
      insert into notification_rules (id, name, type, current_revision_id)
      values ('rule_empty', 'Empty rule', 'monitor_events', 'revision_empty');
      insert into notification_rule_revisions
        (id, rule_id, revision_number, channel_ids_json)
      values ('revision_empty', 'rule_empty', 1, '[]');
      insert into notification_routes
        (id, name, enabled, matcher_json, channel_ids_json)
      values ('route_malformed', 'Malformed channels', 1, '{}', '"channel_default"');
    `);
    malformedLegacy.close();

    const malformedUpgraded = openDatabase({ path: malformedDatabasePath });
    try {
      const rule = malformedUpgraded.sqlite.prepare(
        'select current_revision_id from notification_rules where id = ?',
      ).get('rule_empty') as { current_revision_id: string };
      expect(rule.current_revision_id).toBe('revision_empty');
      const revisionCount = malformedUpgraded.sqlite.prepare(
        'select count(*) as value from notification_rule_revisions where rule_id = ?',
      ).get('rule_empty') as { value: number };
      expect(revisionCount.value).toBe(1);
      const route = malformedUpgraded.sqlite.prepare(
        'select enabled, deleted_at from notification_routes where id = ?',
      ).get('route_malformed') as { enabled: number; deleted_at: string | null };
      expect(route.enabled).toBe(0);
      expect(route.deleted_at).not.toBeNull();
    } finally {
      malformedUpgraded.close();
    }
  });

  it('upgrades channels with queued outbox records without rebuilding the parent table', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-channel-upgrade-'));
    temporaryDirectories.push(directory);
    const legacyMigrations = join(directory, 'legacy-migrations');
    const legacyMeta = join(legacyMigrations, 'meta');
    mkdirSync(legacyMeta, { recursive: true });
    const sourceMigrations = join(process.cwd(), 'backend', 'db', 'migrations');
    for (const file of readdirSync(sourceMigrations)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 13)) {
      copyFileSync(join(sourceMigrations, file), join(legacyMigrations, file));
    }
    const journal = JSON.parse(readFileSync(join(sourceMigrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 13);
    writeFileSync(join(legacyMeta, '_journal.json'), JSON.stringify(journal));

    const databasePath = join(directory, 'monitor.db');
    const legacy = openDatabase({ path: databasePath, migrationsFolder: legacyMigrations });
    legacy.sqlite.exec(`
      insert into notification_channels
        (id, name, url, headers_json, allowed_cidrs_json)
      values
        ('channel_with_outbox', 'Legacy webhook', 'https://receiver.example/hook',
         '{"X-Receiver-Key":"plaintext-secret"}', '["10.0.0.0/8"]');
      insert into incidents
        (id, rule_revision_id, resource_key, event_type, fingerprint, active_fingerprint,
         state, severity, summary, first_observed_at, last_observed_at)
      values
        ('incident_with_outbox', 'rulerev_system_event_fallback_v1', 'site:legacy', 'site.timeout',
         'outbox-fingerprint', 'outbox-fingerprint', 'firing', 'warning', 'Legacy incident',
         '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
      insert into outbox_messages
        (id, incident_id, channel_id, event_id, idempotency_key, payload_json, next_attempt_at)
      values
        ('outbox_legacy', 'incident_with_outbox', 'channel_with_outbox', 'event_legacy',
         'idempotency-legacy', '{}', '2026-07-14T00:00:00.000Z');
    `);
    legacy.close();

    const upgraded = openDatabase({ path: databasePath });
    try {
      expect(upgraded.sqlite.prepare(
        `select id, body_mode, headers_json, allowed_cidrs_json
         from notification_channels where id = 'channel_with_outbox'`,
      ).get()).toEqual({
        id: 'channel_with_outbox',
        body_mode: 'json',
        headers_json: '{}',
        allowed_cidrs_json: '[]',
      });
      expect(upgraded.sqlite.prepare(
        `select id, incident_id, channel_id, state
         from outbox_messages where id = 'outbox_legacy'`,
      ).get()).toEqual({
        id: 'outbox_legacy',
        incident_id: 'incident_with_outbox',
        channel_id: 'channel_with_outbox',
        state: 'pending',
      });
      expect(() => upgraded.sqlite.prepare(
        `update notification_channels set body_mode = 'invalid' where id = 'channel_with_outbox'`,
      ).run()).toThrow(/check constraint/i);
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      upgraded.close();
    }
  });

  it('cleans legacy webhook plaintext after the old 0014 and 0015 were already applied', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-channel-cleanup-upgrade-'));
    temporaryDirectories.push(directory);
    const legacyMigrations = join(directory, 'legacy-migrations');
    const legacyMeta = join(legacyMigrations, 'meta');
    mkdirSync(legacyMeta, { recursive: true });
    const sourceMigrations = join(process.cwd(), 'backend', 'db', 'migrations');
    for (const file of readdirSync(sourceMigrations)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 15)) {
      copyFileSync(join(sourceMigrations, file), join(legacyMigrations, file));
    }
    const journal = JSON.parse(readFileSync(join(sourceMigrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 15);
    writeFileSync(join(legacyMeta, '_journal.json'), JSON.stringify(journal));

    const databasePath = join(directory, 'monitor.db');
    const legacy = openDatabase({ path: databasePath, migrationsFolder: legacyMigrations });
    legacy.sqlite.exec(`
      insert into notification_channels
        (id, name, url, headers_json, secret_type, allowed_cidrs_json)
      values
        ('channel_plaintext', 'Legacy plaintext', 'https://receiver.example/plaintext',
         '{"X-Receiver-Key":"plaintext-secret"}', 'hmac_sha256', '["10.0.0.0/8"]'),
        ('channel_encrypted_headers', 'Encrypted headers', 'https://receiver.example/encrypted',
         '{"Authorization":"[REDACTED]"}', 'headers_json', '["192.168.0.0/16"]');
    `);
    legacy.close();

    const upgraded = openDatabase({ path: databasePath });
    try {
      const channels = upgraded.sqlite.prepare(
        `select id, headers_json, allowed_cidrs_json
         from notification_channels order by id`,
      ).all();
      expect(channels).toEqual([
        {
          id: 'channel_encrypted_headers',
          headers_json: '{"Authorization":"[REDACTED]"}',
          allowed_cidrs_json: '[]',
        },
        {
          id: 'channel_plaintext',
          headers_json: '{}',
          allowed_cidrs_json: '[]',
        },
      ]);
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      upgraded.close();
    }
  });

  it('promotes legacy confirmation states and purges archived operational records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-confirmation-upgrade-'));
    temporaryDirectories.push(directory);
    const legacyMigrations = join(directory, 'legacy-migrations');
    const legacyMeta = join(legacyMigrations, 'meta');
    mkdirSync(legacyMeta, { recursive: true });
    const sourceMigrations = join(process.cwd(), 'backend', 'db', 'migrations');
    for (const file of readdirSync(sourceMigrations)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 14)) {
      copyFileSync(join(sourceMigrations, file), join(legacyMigrations, file));
    }
    const journal = JSON.parse(readFileSync(join(sourceMigrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 14);
    writeFileSync(join(legacyMeta, '_journal.json'), JSON.stringify(journal));

    const databasePath = join(directory, 'monitor.db');
    const legacy = openDatabase({ path: databasePath, migrationsFolder: legacyMigrations });
    legacy.sqlite.exec(`
      update notification_rule_revisions
      set trigger_confirm_count = 4, confirmation_duration_seconds = 300
      where id = 'rulerev_system_event_fallback_v1';
      insert into notification_rules (id, name, type, current_revision_id)
      values ('rule_active_legacy', 'Active legacy rule', 'monitor_events', 'revision_active_legacy');
      insert into notification_rule_revisions
        (id, rule_id, revision_number, scope_json, condition_json, channel_ids_json)
      values
        ('revision_active_legacy', 'rule_active_legacy', 1, '{}',
         '{"event_types":["site.timeout","site.auth_expired"]}', '[]');
      insert into incidents
        (id, rule_revision_id, resource_key, event_type, fingerprint, active_fingerprint,
         state, severity, summary, first_observed_at, last_observed_at)
      values
        ('incident_pending', 'revision_active_legacy', 'site', 'site.timeout',
         'pending-fingerprint', 'pending-fingerprint', 'pending', 'warning', 'Pending',
         '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'),
        ('incident_acknowledged', 'revision_active_legacy', 'auth', 'site.auth_expired',
         'ack-fingerprint', 'ack-fingerprint', 'acknowledged', 'warning', 'Acknowledged',
         '2026-07-14T00:01:00.000Z', '2026-07-14T00:01:00.000Z'),
        ('incident_stale_fallback', 'rulerev_system_event_fallback_v1', 'monitor:balance',
         'site.other_error', 'stale-fallback-fingerprint', 'stale-fallback-fingerprint',
         'firing', 'warning', 'Stale fallback incident',
         '2026-07-14T00:02:00.000Z', '2026-07-14T00:02:00.000Z'),
        ('incident_archived', 'rulerev_system_event_fallback_v1', 'rate:old', 'rate.changed',
         'archived-fingerprint', null, 'resolved', 'warning', 'Archived',
         '2026-07-14T00:03:00.000Z', '2026-07-14T00:03:00.000Z');
      update incidents
      set acknowledged_at = '2026-07-14T00:01:30.000Z', deleted_at = null
      where id = 'incident_acknowledged';
      update incidents set deleted_at = '2026-07-14T01:00:00.000Z'
      where id = 'incident_archived';
      insert into audit_logs (id, action, resource_type, deleted_at)
      values ('audit_archived', 'legacy.archive', 'incident', '2026-07-14T01:00:00.000Z');
      insert into maintenance_windows (id, name, kind, timezone, deleted_at)
      values ('maintenance_archived', 'Legacy maintenance', 'manual', 'Asia/Shanghai',
              '2026-07-14T01:00:00.000Z');
      insert into silences (id, matcher_json, reason, starts_at, ends_at, deleted_at)
      values ('silence_archived', '{}', 'Legacy silence', '2026-07-14T00:00:00.000Z',
              '2026-07-15T00:00:00.000Z', '2026-07-14T01:00:00.000Z');
    `);
    legacy.close();

    const upgraded = openDatabase({ path: databasePath });
    try {
      expect(upgraded.sqlite.prepare(
        `select state, active_fingerprint, fired_at, acknowledged_at
         from incidents where id = 'incident_pending'`,
      ).get()).toEqual({
        state: 'firing',
        active_fingerprint: 'pending-fingerprint',
        fired_at: '2026-07-14T00:00:00.000Z',
        acknowledged_at: null,
      });
      expect(upgraded.sqlite.prepare(
        `select state, fired_at, acknowledged_at
         from incidents where id = 'incident_acknowledged'`,
      ).get()).toEqual({
        state: 'firing',
        fired_at: '2026-07-14T00:01:00.000Z',
        acknowledged_at: null,
      });
      expect(upgraded.sqlite.prepare(
        `select state, active_fingerprint, suppression_reason
         from incidents where id = 'incident_stale_fallback'`,
      ).get()).toEqual({
        state: 'suppressed',
        active_fingerprint: null,
        suppression_reason: 'rule_revision_replaced',
      });
      expect(upgraded.sqlite.prepare(
        `select trigger_confirm_count, confirmation_duration_seconds
         from notification_rule_revisions where id = 'rulerev_system_event_fallback_v1'`,
      ).get()).toEqual({ trigger_confirm_count: 4, confirmation_duration_seconds: 300 });
      for (const [table, id] of [
        ['incidents', 'incident_archived'],
        ['audit_logs', 'audit_archived'],
        ['maintenance_windows', 'maintenance_archived'],
        ['silences', 'silence_archived'],
      ]) {
        expect(upgraded.sqlite.prepare(`select id from ${table} where id = ?`).get(id)).toBeUndefined();
      }
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      upgraded.close();
    }
  });

  it('clears legacy rate candidates and merges authentication incidents during upgrade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-monitor-auth-root-upgrade-'));
    temporaryDirectories.push(directory);
    const legacyMigrations = join(directory, 'legacy-migrations');
    const legacyMeta = join(legacyMigrations, 'meta');
    mkdirSync(legacyMeta, { recursive: true });
    const sourceMigrations = join(process.cwd(), 'backend', 'db', 'migrations');
    for (const file of readdirSync(sourceMigrations)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 20)) {
      copyFileSync(join(sourceMigrations, file), join(legacyMigrations, file));
    }
    const journal = JSON.parse(readFileSync(join(sourceMigrations, 'meta', '_journal.json'), 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 20);
    writeFileSync(join(legacyMeta, '_journal.json'), JSON.stringify(journal));

    const databasePath = join(directory, 'monitor.db');
    const legacy = openDatabase({ path: databasePath, migrationsFolder: legacyMigrations });
    legacy.sqlite.exec(`
      insert into sites (id, adapter_type, name, base_url)
      values ('site_auth_upgrade', 'sub2api', 'Auth upgrade', 'https://relay.example');
      insert into rates_current
        (id, site_id, rate_key, rate_kind, name, value, unit, comparison_key,
         metadata_status, candidate_value, candidate_count, missing_count,
         first_seen_at, last_checked_at)
      values
        ('rate_candidate_upgrade', 'site_auth_upgrade', 'group:1:effective', 'group',
         'Group 1', '0.12', 'multiplier', 'sub2api:group:effective:v1', 'stale',
         'sub2api:group:effective:v1|0.12', 1, 1,
         '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:00.000Z');
      insert into notification_rules (id, name, type)
      values ('rule_auth_upgrade', 'Auth events', 'monitor_events');
      insert into notification_rule_revisions
        (id, rule_id, revision_number, scope_json, condition_json, channel_ids_json)
      values
        ('revision_auth_upgrade', 'rule_auth_upgrade', 1, '{}',
         '{"event_types":["site.auth_expired","site.permission_denied"]}', '[]');
      update notification_rules set current_revision_id = 'revision_auth_upgrade'
      where id = 'rule_auth_upgrade';
      insert into incidents
        (id, rule_revision_id, site_id, resource_key, event_type, fingerprint,
         active_fingerprint, state, severity, summary, trigger_count, recovery_count,
         repeat_count, first_observed_at, fired_at, last_observed_at, last_notified_at)
      values
        ('incident_auth_root', 'revision_auth_upgrade', 'site_auth_upgrade', 'auth',
         'site.auth_expired', 'auth-root-fingerprint', 'auth-root-fingerprint', 'firing',
         'warning', 'Auth root', 3, 0, 0, '2026-07-16T12:01:00.000Z',
         '2026-07-16T12:01:00.000Z', '2026-07-16T12:04:00.000Z', null),
        ('incident_auth_site', 'revision_auth_upgrade', 'site_auth_upgrade', 'site',
         'site.auth_expired', 'auth-site-fingerprint', 'auth-site-fingerprint', 'firing',
         'warning', 'Auth from connectivity', 4, 1, 1, '2026-07-16T12:00:00.000Z',
         '2026-07-16T12:00:00.000Z', '2026-07-16T12:05:00.000Z',
         '2026-07-16T12:03:00.000Z'),
        ('incident_auth_balance', 'revision_auth_upgrade', 'site_auth_upgrade',
         'monitor:balance', 'site.permission_denied', 'auth-balance-fingerprint',
         'auth-balance-fingerprint', 'firing', 'warning', 'Auth from balance', 2, 0, 0,
         '2026-07-16T12:02:00.000Z', '2026-07-16T12:02:00.000Z',
         '2026-07-16T12:06:00.000Z', null),
        ('incident_auth_rates', 'revision_auth_upgrade', 'site_auth_upgrade',
         'monitor:rates', 'site.auth_expired', 'auth-rates-fingerprint',
         'auth-rates-fingerprint', 'firing', 'warning', 'Auth from rates', 2, 0, 0,
         '2026-07-16T12:03:00.000Z', '2026-07-16T12:03:00.000Z',
         '2026-07-16T12:07:00.000Z', null);
    `);
    legacy.close();

    const upgraded = openDatabase({ path: databasePath });
    try {
      expect(upgraded.sqlite.prepare(
        `select candidate_value, candidate_count, missing_count
         from rates_current where id = 'rate_candidate_upgrade'`,
      ).get()).toEqual({ candidate_value: null, candidate_count: 0, missing_count: 0 });
      expect(upgraded.sqlite.prepare(
        `select id, resource_key, trigger_count, recovery_count, repeat_count,
                first_observed_at, last_observed_at, last_notified_at
         from incidents
         where rule_revision_id = 'revision_auth_upgrade' and state = 'firing'`,
      ).all()).toEqual([{
        id: 'incident_auth_root',
        resource_key: 'auth',
        trigger_count: 4,
        recovery_count: 1,
        repeat_count: 1,
        first_observed_at: '2026-07-16T12:00:00.000Z',
        last_observed_at: '2026-07-16T12:07:00.000Z',
        last_notified_at: '2026-07-16T12:03:00.000Z',
      }]);
      const suppressed = upgraded.sqlite.prepare(
        `select id, active_fingerprint, suppressed_by_incident_id, suppression_reason
         from incidents
         where rule_revision_id = 'revision_auth_upgrade' and state = 'suppressed'
         order by id`,
      ).all();
      expect(suppressed).toEqual([
        {
          id: 'incident_auth_balance',
          active_fingerprint: null,
          suppressed_by_incident_id: 'incident_auth_root',
          suppression_reason: 'auth_root_cause_merged',
        },
        {
          id: 'incident_auth_rates',
          active_fingerprint: null,
          suppressed_by_incident_id: 'incident_auth_root',
          suppression_reason: 'auth_root_cause_merged',
        },
        {
          id: 'incident_auth_site',
          active_fingerprint: null,
          suppressed_by_incident_id: 'incident_auth_root',
          suppression_reason: 'auth_root_cause_merged',
        },
      ]);
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      upgraded.close();
    }
  });

  it('enforces foreign keys', () => {
    const connection = openDatabase({ path: ':memory:' });
    try {
      expect(() =>
        connection.sqlite
          .prepare(
            `insert into credentials
              (id, site_id, credential_type, ciphertext, nonce, auth_tag, key_version)
             values ('cred_test', 'site_missing', 'api_key', x'01', x'000000000000000000000000',
                     x'00000000000000000000000000000000', 1)`,
          )
          .run(),
      ).toThrow(/foreign key/i);
    } finally {
      connection.close();
    }
  });
});
