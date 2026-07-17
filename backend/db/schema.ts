import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import {
  DEFAULT_RATE_PROBE_INTERVAL_SECONDS,
  DEFAULT_RATE_PROBE_RETRY_COUNT,
  DEFAULT_RATE_PROBE_RETRY_INTERVAL_SECONDS,
  DEFAULT_RATE_PROBE_TIMEOUT_SECONDS,
  MAX_RATE_PROBE_INTERVAL_SECONDS,
  MAX_RATE_PROBE_TIMEOUT_SECONDS,
  MIN_RATE_PROBE_INTERVAL_SECONDS,
  MIN_RATE_PROBE_TIMEOUT_SECONDS,
} from '../../shared/constants.js';

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const admins = sqliteTable(
  'admins',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: text('locked_until'),
    lastLoginAt: text('last_login_at'),
    passwordChangedAt: text('password_changed_at').notNull().default(utcNow),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [uniqueIndex('admins_username_uq').on(table.username)],
);

export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    adminId: text('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    lastSeenAt: text('last_seen_at').notNull().default(utcNow),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('admin_sessions_token_hash_uq').on(table.tokenHash),
    index('admin_sessions_admin_expiry_idx').on(table.adminId, table.expiresAt),
  ],
);

export const serverAccessSettings = sqliteTable(
  'server_access_settings',
  {
    id: text('id').primaryKey(),
    tlsEnabled: integer('tls_enabled', { mode: 'boolean' }).notNull().default(false),
    accessHost: text('access_host').notNull(),
    tlsMaterialId: text('tls_material_id'),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('server_access_settings_singleton_ck', sql`${table.id} = 'global'`),
    check('server_access_settings_host_ck', sql`length(trim(${table.accessHost})) > 0`),
  ],
);

export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    adapterType: text('adapter_type').notNull(),
    adapterVersion: text('adapter_version'),
    adapterSchemaVersion: text('adapter_schema_version'),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    tagsJson: text('tags_json').notNull().default('[]'),
    notes: text('notes'),
    rateGroupScopeMode: text('rate_group_scope_mode').notNull().default('all'),
    rateGroupIdsJson: text('rate_group_ids_json').notNull().default('[]'),
    excludedRateGroupIdsJson: text('excluded_rate_group_ids_json').notNull().default('[]'),
    tlsVerify: integer('tls_verify', { mode: 'boolean' }).notNull().default(true),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    serviceStatus: text('service_status').notNull().default('unknown'),
    authStatus: text('auth_status').notNull().default('unknown'),
    credentialMode: text('credential_mode'),
    accessExpiresAt: text('access_expires_at'),
    lastSuccessAt: text('last_success_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    index('sites_adapter_idx').on(table.adapterType),
    index('sites_status_idx').on(table.serviceStatus, table.authStatus),
    check('sites_service_status_ck', sql`${table.serviceStatus} in ('healthy','degraded','down','unknown','adapter_unavailable')`),
    check('sites_auth_status_ck', sql`${table.authStatus} in ('authenticated','refreshing','reauth_required','interaction_required','invalid_credentials','disabled','unknown')`),
    check('sites_rate_group_scope_mode_ck', sql`${table.rateGroupScopeMode} in ('all','selected')`),
  ],
);

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    credentialType: text('credential_type').notNull(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    nonce: blob('nonce', { mode: 'buffer' }).notNull(),
    authTag: blob('auth_tag', { mode: 'buffer' }).notNull(),
    keyVersion: integer('key_version').notNull(),
    expiresAt: text('expires_at'),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('credentials_site_type_version_uq').on(table.siteId, table.credentialType, table.keyVersion),
    index('credentials_site_active_idx').on(table.siteId, table.revokedAt),
    check('credentials_key_version_ck', sql`${table.keyVersion} > 0`),
  ],
);

export const siteCapabilities = sqliteTable(
  'site_capabilities',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    capabilityKey: text('capability_key').notNull(),
    status: text('status').notNull().default('unknown'),
    adapterVersion: text('adapter_version').notNull(),
    adapterSchemaVersion: text('adapter_schema_version').notNull(),
    upstreamVersion: text('upstream_version'),
    structureFingerprint: text('structure_fingerprint'),
    detailsJson: text('details_json').notNull().default('{}'),
    lastErrorCode: text('last_error_code'),
    lastErrorFingerprint: text('last_error_fingerprint'),
    detectedAt: text('detected_at').notNull(),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('site_capabilities_site_key_uq').on(table.siteId, table.capabilityKey),
    check('site_capabilities_status_ck', sql`${table.status} in ('supported','unsupported','unknown','incompatible')`),
  ],
);

export const monitorConfigs = sqliteTable(
  'monitor_configs',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    monitorType: text('monitor_type').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    intervalSeconds: integer('interval_seconds').notNull().default(300),
    timeoutSeconds: integer('timeout_seconds').notNull().default(15),
    retryCount: integer('retry_count').notNull().default(1),
    retryIntervalSeconds: integer('retry_interval_seconds').notNull().default(60),
    scheduleJitterPercent: integer('schedule_jitter_percent').notNull().default(10),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('monitor_configs_site_type_uq').on(table.siteId, table.monitorType),
    check('monitor_configs_type_ck', sql`${table.monitorType} in ('connectivity','rates','balance','auth')`),
    check('monitor_configs_interval_ck', sql`${table.intervalSeconds} >= 10 and ${table.intervalSeconds} <= 86400`),
    check('monitor_configs_timeout_ck', sql`${table.timeoutSeconds} >= 1 and ${table.timeoutSeconds} <= 120`),
    check('monitor_configs_retry_count_ck', sql`${table.retryCount} >= 0 and ${table.retryCount} <= 10`),
    check('monitor_configs_retry_interval_ck', sql`${table.retryIntervalSeconds} >= 0 and ${table.retryIntervalSeconds} <= 3600`),
    check('monitor_configs_jitter_ck', sql`${table.scheduleJitterPercent} >= 0 and ${table.scheduleJitterPercent} <= 50`),
  ],
);

export const monitorJobs = sqliteTable(
  'monitor_jobs',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    monitorType: text('monitor_type').notNull(),
    state: text('state').notNull().default('queued'),
    nextRunAt: text('next_run_at').notNull(),
    leaseOwner: text('lease_owner'),
    leaseUntil: text('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    runRequested: integer('run_requested', { mode: 'boolean' }).notNull().default(false),
    retryAfter: text('retry_after'),
    lastStartedAt: text('last_started_at'),
    lastFinishedAt: text('last_finished_at'),
    lastSuccessAt: text('last_success_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('monitor_jobs_site_type_uq').on(table.siteId, table.monitorType),
    index('monitor_jobs_due_idx').on(table.state, table.nextRunAt, table.leaseUntil),
    index('monitor_jobs_site_lease_idx').on(table.siteId, table.leaseUntil),
    check('monitor_jobs_type_ck', sql`${table.monitorType} in ('connectivity','rates','balance','auth')`),
    check('monitor_jobs_state_ck', sql`${table.state} in ('queued','running','retry','disabled')`),
  ],
);

export const healthChecks = sqliteTable(
  'health_checks',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    probeKind: text('probe_kind').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    dnsMs: integer('dns_ms'),
    tcpMs: integer('tcp_ms'),
    tlsMs: integer('tls_ms'),
    httpMs: integer('http_ms'),
    totalMs: integer('total_ms'),
    httpStatus: integer('http_status'),
    authPassed: integer('auth_passed', { mode: 'boolean' }),
    modelCount: integer('model_count'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    checkedAt: text('checked_at').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [index('health_checks_site_time_idx').on(table.siteId, table.checkedAt)],
);

export const balanceSnapshots = sqliteTable(
  'balance_snapshots',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    balanceKey: text('balance_key').notNull(),
    balanceKind: text('balance_kind').notNull(),
    value: text('value').notNull(),
    available: text('available'),
    frozen: text('frozen'),
    total: text('total'),
    changeValue: text('change_value'),
    consumption24h: text('consumption_24h'),
    consumption7d: text('consumption_7d'),
    currency: text('currency'),
    unit: text('unit').notNull(),
    precision: integer('precision'),
    sourceSemantics: text('source_semantics'),
    loginReadable: integer('login_readable', { mode: 'boolean' }),
    collectedAt: text('collected_at').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    index('balance_snapshots_site_key_time_idx').on(table.siteId, table.balanceKey, table.collectedAt),
    check('balance_snapshots_kind_ck', sql`${table.balanceKind} in ('cash','credit','quota','token','custom')`),
  ],
);

export const balancesCurrent = sqliteTable(
  'balances_current',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    balanceKey: text('balance_key').notNull(),
    balanceKind: text('balance_kind').notNull(),
    value: text('value').notNull(),
    available: text('available'),
    frozen: text('frozen'),
    total: text('total'),
    changeValue: text('change_value'),
    consumption24h: text('consumption_24h'),
    consumption7d: text('consumption_7d'),
    currency: text('currency'),
    unit: text('unit').notNull(),
    precision: integer('precision'),
    sourceSemantics: text('source_semantics'),
    loginReadable: integer('login_readable', { mode: 'boolean' }),
    snapshotId: text('snapshot_id').references(() => balanceSnapshots.id, { onDelete: 'set null' }),
    lastChangedAt: text('last_changed_at'),
    lastCheckedAt: text('last_checked_at').notNull(),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('balances_current_site_key_uq').on(table.siteId, table.balanceKey),
    check('balances_current_kind_ck', sql`${table.balanceKind} in ('cash','credit','quota','token','custom')`),
  ],
);

export const balanceAlertSettings = sqliteTable(
  'balance_alert_settings',
  {
    id: text('id').primaryKey(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    threshold: text('threshold').notNull().default('10'),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('balance_alert_settings_singleton_ck', sql`${table.id} = 'global'`),
    check('balance_alert_settings_threshold_ck', sql`length(trim(${table.threshold})) > 0`),
  ],
);

export const rateSnapshots = sqliteTable(
  'rate_snapshots',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    quality: text('quality').notNull(),
    fingerprint: text('fingerprint'),
    itemCount: integer('item_count').notNull().default(0),
    adapterSchemaVersion: text('adapter_schema_version'),
    errorsJson: text('errors_json').notNull().default('[]'),
    collectedAt: text('collected_at').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    index('rate_snapshots_site_time_idx').on(table.siteId, table.collectedAt),
    check('rate_snapshots_quality_ck', sql`${table.quality} in ('complete','partial','unsupported')`),
  ],
);

export const ratesCurrent = sqliteTable(
  'rates_current',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    rateKey: text('rate_key').notNull(),
    rateKind: text('rate_kind').notNull(),
    name: text('name').notNull(),
    platform: text('platform'),
    groupName: text('group_name'),
    model: text('model'),
    value: text('value').notNull(),
    unit: text('unit').notNull(),
    comparisonKey: text('comparison_key').notNull(),
    billingExpression: text('billing_expression'),
    attributesJson: text('attributes_json').notNull().default('{}'),
    metadataStatus: text('metadata_status').notNull().default('available'),
    probeStatus: text('probe_status').notNull().default('not_configured'),
    snapshotId: text('snapshot_id').references(() => rateSnapshots.id, { onDelete: 'set null' }),
    candidateValue: text('candidate_value'),
    candidateCount: integer('candidate_count').notNull().default(0),
    missingCount: integer('missing_count').notNull().default(0),
    matchConfidence: text('match_confidence').notNull().default('high'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastCheckedAt: text('last_checked_at').notNull(),
    lastChangedAt: text('last_changed_at'),
    removedAt: text('removed_at'),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('rates_current_site_key_uq').on(table.siteId, table.rateKey),
    index('rates_current_comparison_idx').on(table.comparisonKey, table.removedAt),
    index('rates_current_site_kind_idx').on(table.siteId, table.rateKind),
    check('rates_current_kind_ck', sql`${table.rateKind} in ('group','model','completion','user_override','fixed_price','peak','custom')`),
  ],
);

export const rateProbeConfigs = sqliteTable(
  'rate_probe_configs',
  {
    id: text('id').primaryKey(),
    rateId: text('rate_id')
      .notNull()
      .references(() => ratesCurrent.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    modelMode: text('model_mode').notNull().default('auto'),
    model: text('model'),
    useSiteApiKey: integer('use_site_api_key', { mode: 'boolean' }).notNull().default(true),
    keyMode: text('key_mode').notNull().default('bound'),
    customCredentialType: text('custom_credential_type'),
    upstreamKeyId: text('upstream_key_id'),
    upstreamKeyManaged: integer('upstream_key_managed', { mode: 'boolean' }).notNull().default(false),
    maxOutputTokens: integer('max_output_tokens').notNull().default(96),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    intervalSeconds: integer('interval_seconds').notNull().default(DEFAULT_RATE_PROBE_INTERVAL_SECONDS),
    timeoutSeconds: integer('timeout_seconds').notNull().default(DEFAULT_RATE_PROBE_TIMEOUT_SECONDS),
    retryCount: integer('retry_count').notNull().default(DEFAULT_RATE_PROBE_RETRY_COUNT),
    retryIntervalSeconds: integer('retry_interval_seconds')
      .notNull()
      .default(DEFAULT_RATE_PROBE_RETRY_INTERVAL_SECONDS),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    autoCreateQuotaLimit: text('auto_create_quota_limit'),
    autoCreateExpiresInSeconds: integer('auto_create_expires_in_seconds'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('rate_probe_configs_rate_uq').on(table.rateId),
    index('rate_probe_configs_site_idx').on(table.siteId),
    index('rate_probe_configs_due_idx').on(table.enabled, table.nextRunAt),
    check('rate_probe_configs_model_mode_ck', sql`${table.modelMode} in ('auto','manual')`),
    check('rate_probe_configs_key_mode_ck', sql`${table.keyMode} in ('bound','existing','auto_create','manual')`),
    check('rate_probe_configs_max_tokens_ck', sql`${table.maxOutputTokens} >= 1 and ${table.maxOutputTokens} <= 256`),
    check(
      'rate_probe_configs_interval_ck',
      sql`${table.intervalSeconds} >= ${sql.raw(String(MIN_RATE_PROBE_INTERVAL_SECONDS))} and ${table.intervalSeconds} <= ${sql.raw(String(MAX_RATE_PROBE_INTERVAL_SECONDS))}`,
    ),
    check(
      'rate_probe_configs_timeout_ck',
      sql`${table.timeoutSeconds} >= ${sql.raw(String(MIN_RATE_PROBE_TIMEOUT_SECONDS))} and ${table.timeoutSeconds} <= ${sql.raw(String(MAX_RATE_PROBE_TIMEOUT_SECONDS))}`,
    ),
    check('rate_probe_configs_retry_count_ck', sql`${table.retryCount} >= 0 and ${table.retryCount} <= 10`),
    check('rate_probe_configs_retry_interval_ck', sql`${table.retryIntervalSeconds} >= 0 and ${table.retryIntervalSeconds} <= 3600`),
  ],
);

export const siteProbeKeyMappings = sqliteTable(
  'site_probe_key_mappings',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    groupId: text('group_id').notNull(),
    keyMode: text('key_mode').notNull(),
    upstreamKeyId: text('upstream_key_id'),
    upstreamKeyManaged: integer('upstream_key_managed', { mode: 'boolean' }).notNull().default(false),
    credentialType: text('credential_type').notNull(),
    quotaLimit: text('quota_limit'),
    expiresInSeconds: integer('expires_in_seconds'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('site_probe_key_mappings_site_group_uq').on(table.siteId, table.groupId),
    index('site_probe_key_mappings_site_idx').on(table.siteId),
    check('site_probe_key_mappings_mode_ck', sql`${table.keyMode} in ('existing','auto_create')`),
  ],
);

export const rateProbeRuns = sqliteTable(
  'rate_probe_runs',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').references(() => rateProbeConfigs.id, { onDelete: 'set null' }),
    rateId: text('rate_id')
      .notNull()
      .references(() => ratesCurrent.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    attemptCount: integer('attempt_count').notNull().default(1),
    heartbeatAt: text('heartbeat_at'),
    requestedModel: text('requested_model').notNull(),
    returnedModel: text('returned_model'),
    ttfbMs: integer('ttfb_ms'),
    ttftMs: integer('ttft_ms'),
    totalMs: integer('total_ms'),
    generationMs: integer('generation_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    expectedInputTokens: integer('expected_input_tokens'),
    inputTokenDelta: integer('input_token_delta'),
    inputTokenAssessment: text('input_token_assessment').notNull().default('unknown'),
    toolCallsObserved: integer('tool_calls_observed', { mode: 'boolean' }).notNull().default(false),
    tps: text('tps'),
    finishReason: text('finish_reason'),
    systemFingerprint: text('system_fingerprint'),
    promptIntegrity: text('prompt_integrity').notNull().default('unknown'),
    knowledgeProbe: text('knowledge_probe').notNull().default('unknown'),
    modelIdentity: text('model_identity').notNull().default('unknown'),
    evidenceJson: text('evidence_json').notNull().default('{}'),
    responseHash: text('response_hash'),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: text('started_at').notNull().default(utcNow),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    index('rate_probe_runs_rate_time_idx').on(table.rateId, table.startedAt),
    index('rate_probe_runs_site_time_idx').on(table.siteId, table.startedAt),
    uniqueIndex('rate_probe_runs_one_running_site_uq')
      .on(table.siteId)
      .where(sql`${table.status} = 'running'`),
    check('rate_probe_runs_status_ck', sql`${table.status} in ('running','succeeded','failed')`),
    check('rate_probe_runs_attempt_count_ck', sql`${table.attemptCount} >= 1`),
    check('rate_probe_runs_prompt_integrity_ck', sql`${table.promptIntegrity} in ('no_interference_observed','suspected','unknown')`),
    check('rate_probe_runs_knowledge_probe_ck', sql`${table.knowledgeProbe} in ('weak_consistency','suspicious','not_applicable','unknown')`),
    check('rate_probe_runs_model_identity_ck', sql`${table.modelIdentity} in ('declared_match','declared_mismatch','unknown')`),
    check('rate_probe_runs_input_token_assessment_ck', sql`${table.inputTokenAssessment} in ('within_expected','higher_than_expected','unknown')`),
    check('rate_probe_runs_ttfb_ck', sql`${table.ttfbMs} is null or ${table.ttfbMs} >= 0`),
    check('rate_probe_runs_ttft_ck', sql`${table.ttftMs} is null or ${table.ttftMs} >= 0`),
    check('rate_probe_runs_total_ck', sql`${table.totalMs} is null or ${table.totalMs} >= 0`),
    check('rate_probe_runs_generation_ck', sql`${table.generationMs} is null or ${table.generationMs} >= 0`),
    check('rate_probe_runs_tokens_ck', sql`(${table.promptTokens} is null or ${table.promptTokens} >= 0) and (${table.completionTokens} is null or ${table.completionTokens} >= 0) and (${table.totalTokens} is null or ${table.totalTokens} >= 0) and (${table.cachedInputTokens} is null or ${table.cachedInputTokens} >= 0) and (${table.reasoningTokens} is null or ${table.reasoningTokens} >= 0) and (${table.expectedInputTokens} is null or ${table.expectedInputTokens} >= 0)`),
  ],
);

export const rateHistory = sqliteTable(
  'rate_history',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    rateKey: text('rate_key').notNull(),
    rateKind: text('rate_kind').notNull(),
    changeType: text('change_type').notNull(),
    direction: text('direction'),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    oldComparisonKey: text('old_comparison_key'),
    newComparisonKey: text('new_comparison_key'),
    snapshotId: text('snapshot_id').references(() => rateSnapshots.id, { onDelete: 'set null' }),
    confirmedAt: text('confirmed_at').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [index('rate_history_site_key_time_idx').on(table.siteId, table.rateKey, table.confirmedAt)],
);

export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().default('webhook'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    url: text('url').notNull(),
    method: text('method').notNull().default('POST'),
    timeoutSeconds: integer('timeout_seconds').notNull().default(10),
    headersJson: text('headers_json').notNull().default('{}'),
    bodyMode: text('body_mode').notNull().default('json'),
    bodyTemplate: text('body_template'),
    secretType: text('secret_type'),
    secretCiphertext: blob('secret_ciphertext', { mode: 'buffer' }),
    secretNonce: blob('secret_nonce', { mode: 'buffer' }),
    secretAuthTag: blob('secret_auth_tag', { mode: 'buffer' }),
    secretKeyVersion: integer('secret_key_version'),
    previousSecretCiphertext: blob('previous_secret_ciphertext', { mode: 'buffer' }),
    previousSecretNonce: blob('previous_secret_nonce', { mode: 'buffer' }),
    previousSecretAuthTag: blob('previous_secret_auth_tag', { mode: 'buffer' }),
    previousSecretKeyVersion: integer('previous_secret_key_version'),
    previousSecretValidUntil: text('previous_secret_valid_until'),
    allowedCidrsJson: text('allowed_cidrs_json').notNull().default('[]'),
    retryDelaysJson: text('retry_delays_json').notNull().default('[60,300,900]'),
    maxResponseBytes: integer('max_response_bytes').notNull().default(65536),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    check('notification_channels_type_ck', sql`${table.type} = 'webhook'`),
    check('notification_channels_body_mode_ck', sql`${table.bodyMode} in ('json','form_data','custom')`),
  ],
);

export const notificationRoutes = sqliteTable(
  'notification_routes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    position: integer('position').notNull().default(0),
    matcherJson: text('matcher_json').notNull().default('{}'),
    channelIdsJson: text('channel_ids_json').notNull().default('[]'),
    continueMatching: integer('continue_matching', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
    deletedAt: text('deleted_at'),
  },
  (table) => [index('notification_routes_position_idx').on(table.enabled, table.position)],
);

export const notificationRules = sqliteTable(
  'notification_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    severity: text('severity').notNull().default('warning'),
    currentRevisionId: text('current_revision_id'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
    deletedAt: text('deleted_at'),
  },
  (table) => [index('notification_rules_type_idx').on(table.type, table.enabled)],
);

export const notificationRuleRevisions = sqliteTable(
  'notification_rule_revisions',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => notificationRules.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    scopeJson: text('scope_json').notNull().default('{}'),
    conditionJson: text('condition_json').notNull().default('{}'),
    triggerConfirmCount: integer('trigger_confirm_count').notNull().default(2),
    recoveryConfirmCount: integer('recovery_confirm_count').notNull().default(2),
    confirmationDurationSeconds: integer('confirmation_duration_seconds'),
    digestWindowSeconds: integer('digest_window_seconds').notNull().default(60),
    cooldownSeconds: integer('cooldown_seconds').notNull().default(300),
    repeatIntervalSeconds: integer('repeat_interval_seconds').notNull().default(0),
    maxRepeats: integer('max_repeats').notNull().default(0),
    sendRecovery: integer('send_recovery', { mode: 'boolean' }).notNull().default(true),
    channelIdsJson: text('channel_ids_json').notNull().default('[]'),
    createdByAdminId: text('created_by_admin_id').references(() => admins.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('notification_rule_revisions_number_uq').on(table.ruleId, table.revisionNumber),
    check('notification_rule_revisions_counts_ck', sql`${table.triggerConfirmCount} > 0 and ${table.recoveryConfirmCount} > 0 and ${table.maxRepeats} >= 0`),
  ],
);

export const incidents = sqliteTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    ruleRevisionId: text('rule_revision_id')
      .notNull()
      .references(() => notificationRuleRevisions.id, { onDelete: 'restrict' }),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
    resourceKey: text('resource_key').notNull(),
    eventType: text('event_type').notNull(),
    fingerprint: text('fingerprint').notNull(),
    activeFingerprint: text('active_fingerprint'),
    state: text('state').notNull().default('pending'),
    severity: text('severity').notNull(),
    summary: text('summary').notNull(),
    detailsJson: text('details_json').notNull().default('{}'),
    triggerCount: integer('trigger_count').notNull().default(0),
    recoveryCount: integer('recovery_count').notNull().default(0),
    repeatCount: integer('repeat_count').notNull().default(0),
    firstObservedAt: text('first_observed_at').notNull(),
    firedAt: text('fired_at'),
    acknowledgedAt: text('acknowledged_at'),
    acknowledgedByAdminId: text('acknowledged_by_admin_id').references(() => admins.id, { onDelete: 'set null' }),
    resolvedAt: text('resolved_at'),
    lastObservedAt: text('last_observed_at').notNull(),
    lastNotifiedAt: text('last_notified_at'),
    suppressedByIncidentId: text('suppressed_by_incident_id'),
    suppressionReason: text('suppression_reason'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('incidents_active_fingerprint_uq').on(table.activeFingerprint),
    index('incidents_site_state_idx').on(table.siteId, table.state),
    index('incidents_event_state_idx').on(table.eventType, table.state),
    index('incidents_active_time_idx').on(table.deletedAt, table.lastObservedAt),
    check('incidents_state_ck', sql`${table.state} in ('normal','pending','firing','acknowledged','recovering','resolved','paused','suppressed')`),
  ],
);

export const maintenanceWindows = sqliteTable(
  'maintenance_windows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    kind: text('kind').notNull(),
    matcherJson: text('matcher_json').notNull().default('{}'),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
    cronExpression: text('cron_expression'),
    durationSeconds: integer('duration_seconds'),
    timezone: text('timezone').notNull(),
    reason: text('reason').notNull().default(''),
    createdByAdminId: text('created_by_admin_id').references(() => admins.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
    deletedAt: text('deleted_at'),
  },
  (table) => [check('maintenance_windows_kind_ck', sql`${table.kind} in ('manual','once','cron')`)],
);

export const silences = sqliteTable(
  'silences',
  {
    id: text('id').primaryKey(),
    matcherJson: text('matcher_json').notNull(),
    reason: text('reason').notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    createdByAdminId: text('created_by_admin_id').references(() => admins.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(utcNow),
    deletedAt: text('deleted_at'),
  },
  (table) => [index('silences_active_idx').on(table.startsAt, table.endsAt, table.deletedAt)],
);

export const inhibitionRules = sqliteTable(
  'inhibition_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sourceMatcherJson: text('source_matcher_json').notNull(),
    targetMatcherJson: text('target_matcher_json').notNull(),
    equalLabelsJson: text('equal_labels_json').notNull().default('["site_id"]'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
);

export const outboxMessages = sqliteTable(
  'outbox_messages',
  {
    id: text('id').primaryKey(),
    incidentId: text('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'restrict' }),
    routeId: text('route_id').references(() => notificationRoutes.id, { onDelete: 'set null' }),
    eventId: text('event_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    schemaVersion: text('schema_version').notNull().default('1.0'),
    state: text('state').notNull().default('pending'),
    payloadJson: text('payload_json').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at').notNull(),
    leaseOwner: text('lease_owner'),
    leaseUntil: text('lease_until'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    sentAt: text('sent_at'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('outbox_messages_event_channel_uq').on(table.eventId, table.channelId),
    index('outbox_messages_due_idx').on(table.state, table.nextAttemptAt, table.leaseUntil),
    check('outbox_messages_state_ck', sql`${table.state} in ('pending','sending','retry','sent','dead')`),
  ],
);

export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    outboxMessageId: text('outbox_message_id')
      .notNull()
      .references(() => outboxMessages.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    requestTimestamp: text('request_timestamp').notNull(),
    responseStatus: integer('response_status'),
    durationMs: integer('duration_ms'),
    responseBodyTruncated: text('response_body_truncated'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    uniqueIndex('notification_deliveries_attempt_uq').on(table.outboxMessageId, table.attemptNumber),
    index('notification_deliveries_created_idx').on(table.createdAt),
  ],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    adminId: text('admin_id').references(() => admins.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    index('audit_logs_resource_time_idx').on(table.resourceType, table.resourceId, table.createdAt),
    index('audit_logs_active_time_idx').on(table.deletedAt, table.createdAt),
  ],
);

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull().default('processing'),
    responseStatus: integer('response_status'),
    responseBodyJson: text('response_body_json'),
    resourceId: text('resource_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key_uq').on(table.scope, table.key),
    index('idempotency_keys_expiry_idx').on(table.expiresAt),
    check('idempotency_keys_state_ck', sql`${table.state} in ('processing','completed','failed')`),
  ],
);

export const schema = {
  admins,
  adminSessions,
  serverAccessSettings,
  sites,
  credentials,
  siteCapabilities,
  monitorConfigs,
  monitorJobs,
  healthChecks,
  balanceSnapshots,
  balancesCurrent,
  balanceAlertSettings,
  rateSnapshots,
  ratesCurrent,
  rateProbeConfigs,
  siteProbeKeyMappings,
  rateProbeRuns,
  rateHistory,
  notificationChannels,
  notificationRoutes,
  notificationRules,
  notificationRuleRevisions,
  incidents,
  maintenanceWindows,
  silences,
  inhibitionRules,
  outboxMessages,
  notificationDeliveries,
  auditLogs,
  idempotencyKeys,
};

export type Admin = typeof admins.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type MonitorConfig = typeof monitorConfigs.$inferSelect;
export type MonitorJob = typeof monitorJobs.$inferSelect;
export type Incident = typeof incidents.$inferSelect;
