CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_token_hash_uq` ON `admin_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `admin_sessions_admin_expiry_idx` ON `admin_sessions` (`admin_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `admins` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`last_login_at` text,
	`password_changed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admins_username_uq` ON `admins` (`username`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`request_id` text,
	`ip_address` text,
	`user_agent` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_resource_time_idx` ON `audit_logs` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`balance_key` text NOT NULL,
	`balance_kind` text NOT NULL,
	`value` text NOT NULL,
	`available` text,
	`frozen` text,
	`total` text,
	`change_value` text,
	`consumption_24h` text,
	`consumption_7d` text,
	`currency` text,
	`unit` text NOT NULL,
	`precision` integer,
	`source_semantics` text,
	`login_readable` integer,
	`collected_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "balance_snapshots_kind_ck" CHECK("balance_snapshots"."balance_kind" in ('cash','credit','quota','token','custom'))
);
--> statement-breakpoint
CREATE INDEX `balance_snapshots_site_key_time_idx` ON `balance_snapshots` (`site_id`,`balance_key`,`collected_at`);--> statement-breakpoint
CREATE TABLE `balances_current` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`balance_key` text NOT NULL,
	`balance_kind` text NOT NULL,
	`value` text NOT NULL,
	`available` text,
	`frozen` text,
	`total` text,
	`change_value` text,
	`consumption_24h` text,
	`consumption_7d` text,
	`currency` text,
	`unit` text NOT NULL,
	`precision` integer,
	`source_semantics` text,
	`login_readable` integer,
	`snapshot_id` text,
	`last_changed_at` text,
	`last_checked_at` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `balance_snapshots`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "balances_current_kind_ck" CHECK("balances_current"."balance_kind" in ('cash','credit','quota','token','custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balances_current_site_key_uq` ON `balances_current` (`site_id`,`balance_key`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`credential_type` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`nonce` blob NOT NULL,
	`auth_tag` blob NOT NULL,
	`key_version` integer NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credentials_key_version_ck" CHECK("credentials"."key_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_site_type_version_uq` ON `credentials` (`site_id`,`credential_type`,`key_version`);--> statement-breakpoint
CREATE INDEX `credentials_site_active_idx` ON `credentials` (`site_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`probe_kind` text NOT NULL,
	`success` integer NOT NULL,
	`dns_ms` integer,
	`tcp_ms` integer,
	`tls_ms` integer,
	`http_ms` integer,
	`total_ms` integer,
	`http_status` integer,
	`auth_passed` integer,
	`model_count` integer,
	`error_code` text,
	`error_message` text,
	`consecutive_successes` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`checked_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `health_checks_site_time_idx` ON `health_checks` (`site_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text DEFAULT 'processing' NOT NULL,
	`response_status` integer,
	`response_body_json` text,
	`resource_id` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	CONSTRAINT "idempotency_keys_state_ck" CHECK("idempotency_keys"."state" in ('processing','completed','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_scope_key_uq` ON `idempotency_keys` (`scope`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expiry_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_revision_id` text NOT NULL,
	`site_id` text,
	`resource_key` text NOT NULL,
	`event_type` text NOT NULL,
	`fingerprint` text NOT NULL,
	`active_fingerprint` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`trigger_count` integer DEFAULT 0 NOT NULL,
	`recovery_count` integer DEFAULT 0 NOT NULL,
	`repeat_count` integer DEFAULT 0 NOT NULL,
	`first_observed_at` text NOT NULL,
	`fired_at` text,
	`acknowledged_at` text,
	`acknowledged_by_admin_id` text,
	`resolved_at` text,
	`last_observed_at` text NOT NULL,
	`last_notified_at` text,
	`suppressed_by_incident_id` text,
	`suppression_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`rule_revision_id`) REFERENCES `notification_rule_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`acknowledged_by_admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "incidents_state_ck" CHECK("incidents"."state" in ('normal','pending','firing','acknowledged','recovering','resolved','paused','suppressed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_active_fingerprint_uq` ON `incidents` (`active_fingerprint`);--> statement-breakpoint
CREATE INDEX `incidents_site_state_idx` ON `incidents` (`site_id`,`state`);--> statement-breakpoint
CREATE INDEX `incidents_event_state_idx` ON `incidents` (`event_type`,`state`);--> statement-breakpoint
CREATE TABLE `inhibition_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_matcher_json` text NOT NULL,
	`target_matcher_json` text NOT NULL,
	`equal_labels_json` text DEFAULT '["site_id"]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`kind` text NOT NULL,
	`matcher_json` text DEFAULT '{}' NOT NULL,
	`starts_at` text,
	`ends_at` text,
	`cron_expression` text,
	`duration_seconds` integer,
	`timezone` text NOT NULL,
	`created_by_admin_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by_admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "maintenance_windows_kind_ck" CHECK("maintenance_windows"."kind" in ('manual','once','cron'))
);
--> statement-breakpoint
CREATE TABLE `monitor_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`monitor_type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_seconds` integer NOT NULL,
	`timeout_seconds` integer DEFAULT 15 NOT NULL,
	`schedule_jitter_percent` integer DEFAULT 10 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monitor_configs_type_ck" CHECK("monitor_configs"."monitor_type" in ('connectivity','rates','balance','auth')),
	CONSTRAINT "monitor_configs_interval_ck" CHECK("monitor_configs"."interval_seconds" >= 10 and "monitor_configs"."interval_seconds" <= 86400),
	CONSTRAINT "monitor_configs_timeout_ck" CHECK("monitor_configs"."timeout_seconds" >= 1 and "monitor_configs"."timeout_seconds" <= 120),
	CONSTRAINT "monitor_configs_jitter_ck" CHECK("monitor_configs"."schedule_jitter_percent" >= 0 and "monitor_configs"."schedule_jitter_percent" <= 50)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_configs_site_type_uq` ON `monitor_configs` (`site_id`,`monitor_type`);--> statement-breakpoint
CREATE TABLE `monitor_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`monitor_type` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`next_run_at` text NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_requested` integer DEFAULT false NOT NULL,
	`retry_after` text,
	`last_started_at` text,
	`last_finished_at` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monitor_jobs_type_ck" CHECK("monitor_jobs"."monitor_type" in ('connectivity','rates','balance','auth')),
	CONSTRAINT "monitor_jobs_state_ck" CHECK("monitor_jobs"."state" in ('queued','running','retry','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_jobs_site_type_uq` ON `monitor_jobs` (`site_id`,`monitor_type`);--> statement-breakpoint
CREATE INDEX `monitor_jobs_due_idx` ON `monitor_jobs` (`state`,`next_run_at`,`lease_until`);--> statement-breakpoint
CREATE INDEX `monitor_jobs_site_lease_idx` ON `monitor_jobs` (`site_id`,`lease_until`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'webhook' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'POST' NOT NULL,
	`timeout_seconds` integer DEFAULT 10 NOT NULL,
	`headers_json` text DEFAULT '{}' NOT NULL,
	`body_template` text,
	`secret_type` text,
	`secret_ciphertext` blob,
	`secret_nonce` blob,
	`secret_auth_tag` blob,
	`secret_key_version` integer,
	`previous_secret_ciphertext` blob,
	`previous_secret_nonce` blob,
	`previous_secret_auth_tag` blob,
	`previous_secret_key_version` integer,
	`previous_secret_valid_until` text,
	`allowed_cidrs_json` text DEFAULT '[]' NOT NULL,
	`retry_delays_json` text DEFAULT '[60,300,900]' NOT NULL,
	`max_response_bytes` integer DEFAULT 65536 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "notification_channels_type_ck" CHECK("notification_channels"."type" = 'webhook')
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`outbox_message_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`request_timestamp` text NOT NULL,
	`response_status` integer,
	`duration_ms` integer,
	`response_body_truncated` text,
	`error_code` text,
	`error_message` text,
	`succeeded` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`outbox_message_id`) REFERENCES `outbox_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_attempt_uq` ON `notification_deliveries` (`outbox_message_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_created_idx` ON `notification_deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`matcher_json` text DEFAULT '{}' NOT NULL,
	`channel_ids_json` text DEFAULT '[]' NOT NULL,
	`continue_matching` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_routes_position_idx` ON `notification_routes` (`enabled`,`position`);--> statement-breakpoint
CREATE TABLE `notification_rule_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`scope_json` text DEFAULT '{}' NOT NULL,
	`condition_json` text DEFAULT '{}' NOT NULL,
	`trigger_confirm_count` integer DEFAULT 2 NOT NULL,
	`recovery_confirm_count` integer DEFAULT 2 NOT NULL,
	`confirmation_duration_seconds` integer,
	`digest_window_seconds` integer DEFAULT 60 NOT NULL,
	`cooldown_seconds` integer DEFAULT 300 NOT NULL,
	`repeat_interval_seconds` integer DEFAULT 0 NOT NULL,
	`max_repeats` integer DEFAULT 0 NOT NULL,
	`send_recovery` integer DEFAULT true NOT NULL,
	`channel_ids_json` text DEFAULT '[]' NOT NULL,
	`created_by_admin_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `notification_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_rule_revisions_counts_ck" CHECK("notification_rule_revisions"."trigger_confirm_count" > 0 and "notification_rule_revisions"."recovery_confirm_count" > 0 and "notification_rule_revisions"."max_repeats" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_rule_revisions_number_uq` ON `notification_rule_revisions` (`rule_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`current_revision_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_rules_type_idx` ON `notification_rules` (`type`,`enabled`);--> statement-breakpoint
CREATE TABLE `outbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`route_id` text,
	`event_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`schema_version` text DEFAULT '1.0' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`payload_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`last_error_code` text,
	`last_error_message` text,
	`sent_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`route_id`) REFERENCES `notification_routes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "outbox_messages_state_ck" CHECK("outbox_messages"."state" in ('pending','sending','retry','sent','dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_messages_event_channel_uq` ON `outbox_messages` (`event_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `outbox_messages_due_idx` ON `outbox_messages` (`state`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `rate_history` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`rate_key` text NOT NULL,
	`rate_kind` text NOT NULL,
	`change_type` text NOT NULL,
	`direction` text,
	`old_value` text,
	`new_value` text,
	`old_comparison_key` text,
	`new_comparison_key` text,
	`snapshot_id` text,
	`confirmed_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `rate_snapshots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rate_history_site_key_time_idx` ON `rate_history` (`site_id`,`rate_key`,`confirmed_at`);--> statement-breakpoint
CREATE TABLE `rate_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`quality` text NOT NULL,
	`fingerprint` text,
	`item_count` integer DEFAULT 0 NOT NULL,
	`adapter_schema_version` text,
	`errors_json` text DEFAULT '[]' NOT NULL,
	`collected_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rate_snapshots_quality_ck" CHECK("rate_snapshots"."quality" in ('complete','partial','unsupported'))
);
--> statement-breakpoint
CREATE INDEX `rate_snapshots_site_time_idx` ON `rate_snapshots` (`site_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `rates_current` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`rate_key` text NOT NULL,
	`rate_kind` text NOT NULL,
	`name` text NOT NULL,
	`platform` text,
	`group_name` text,
	`model` text,
	`value` text NOT NULL,
	`unit` text NOT NULL,
	`comparison_key` text NOT NULL,
	`billing_expression` text,
	`attributes_json` text DEFAULT '{}' NOT NULL,
	`metadata_status` text DEFAULT 'available' NOT NULL,
	`probe_status` text DEFAULT 'not_configured' NOT NULL,
	`snapshot_id` text,
	`candidate_value` text,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`missing_count` integer DEFAULT 0 NOT NULL,
	`match_confidence` text DEFAULT 'high' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_checked_at` text NOT NULL,
	`last_changed_at` text,
	`removed_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `rate_snapshots`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "rates_current_kind_ck" CHECK("rates_current"."rate_kind" in ('group','model','completion','user_override','fixed_price','peak','custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rates_current_site_key_uq` ON `rates_current` (`site_id`,`rate_key`);--> statement-breakpoint
CREATE INDEX `rates_current_comparison_idx` ON `rates_current` (`comparison_key`,`removed_at`);--> statement-breakpoint
CREATE INDEX `rates_current_site_kind_idx` ON `rates_current` (`site_id`,`rate_kind`);--> statement-breakpoint
CREATE TABLE `silences` (
	`id` text PRIMARY KEY NOT NULL,
	`matcher_json` text NOT NULL,
	`reason` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`created_by_admin_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`created_by_admin_id`) REFERENCES `admins`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `silences_active_idx` ON `silences` (`starts_at`,`ends_at`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `site_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`capability_key` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`adapter_version` text NOT NULL,
	`adapter_schema_version` text NOT NULL,
	`upstream_version` text,
	`structure_fingerprint` text,
	`details_json` text DEFAULT '{}' NOT NULL,
	`last_error_code` text,
	`last_error_fingerprint` text,
	`detected_at` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_capabilities_status_ck" CHECK("site_capabilities"."status" in ('supported','unsupported','unknown','incompatible'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_capabilities_site_key_uq` ON `site_capabilities` (`site_id`,`capability_key`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_type` text NOT NULL,
	`adapter_version` text,
	`adapter_schema_version` text,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`tls_verify` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`service_status` text DEFAULT 'unknown' NOT NULL,
	`auth_status` text DEFAULT 'unknown' NOT NULL,
	`credential_mode` text,
	`access_expires_at` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_message` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "sites_service_status_ck" CHECK("sites"."service_status" in ('healthy','degraded','down','unknown','adapter_unavailable')),
	CONSTRAINT "sites_auth_status_ck" CHECK("sites"."auth_status" in ('authenticated','refreshing','reauth_required','interaction_required','invalid_credentials','disabled','unknown'))
);
--> statement-breakpoint
CREATE INDEX `sites_adapter_idx` ON `sites` (`adapter_type`);--> statement-breakpoint
CREATE INDEX `sites_status_idx` ON `sites` (`service_status`,`auth_status`);