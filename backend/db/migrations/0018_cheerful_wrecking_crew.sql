CREATE TABLE `balance_alert_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`threshold` text DEFAULT '10' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "balance_alert_settings_singleton_ck" CHECK("balance_alert_settings"."id" = 'global'),
	CONSTRAINT "balance_alert_settings_threshold_ck" CHECK(length(trim("balance_alert_settings"."threshold")) > 0)
);
--> statement-breakpoint
INSERT INTO `balance_alert_settings` (`id`, `enabled`, `threshold`)
VALUES ('global', 1, '10');
--> statement-breakpoint
CREATE TEMP TABLE `__rate_probe_run_config_links` (
	`run_id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__rate_probe_run_config_links` (`run_id`, `config_id`)
SELECT `id`, `config_id`
FROM `rate_probe_runs`
WHERE `config_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_rate_probe_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`rate_id` text NOT NULL,
	`site_id` text NOT NULL,
	`model_mode` text DEFAULT 'auto' NOT NULL,
	`model` text,
	`use_site_api_key` integer DEFAULT true NOT NULL,
	`key_mode` text DEFAULT 'bound' NOT NULL,
	`custom_credential_type` text,
	`upstream_key_id` text,
	`upstream_key_managed` integer DEFAULT false NOT NULL,
	`max_output_tokens` integer DEFAULT 96 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`interval_seconds` integer DEFAULT 3600 NOT NULL,
	`retry_count` integer DEFAULT 3 NOT NULL,
	`retry_interval_seconds` integer DEFAULT 60 NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`auto_create_quota_limit` text,
	`auto_create_expires_in_seconds` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`rate_id`) REFERENCES `rates_current`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rate_probe_configs_model_mode_ck" CHECK("__new_rate_probe_configs"."model_mode" in ('auto','manual')),
	CONSTRAINT "rate_probe_configs_key_mode_ck" CHECK("__new_rate_probe_configs"."key_mode" in ('bound','existing','auto_create','manual')),
	CONSTRAINT "rate_probe_configs_max_tokens_ck" CHECK("__new_rate_probe_configs"."max_output_tokens" >= 1 and "__new_rate_probe_configs"."max_output_tokens" <= 256),
	CONSTRAINT "rate_probe_configs_interval_ck" CHECK("__new_rate_probe_configs"."interval_seconds" >= 60 and "__new_rate_probe_configs"."interval_seconds" <= 8000000000000),
	CONSTRAINT "rate_probe_configs_retry_count_ck" CHECK("__new_rate_probe_configs"."retry_count" >= 0 and "__new_rate_probe_configs"."retry_count" <= 10),
	CONSTRAINT "rate_probe_configs_retry_interval_ck" CHECK("__new_rate_probe_configs"."retry_interval_seconds" >= 0 and "__new_rate_probe_configs"."retry_interval_seconds" <= 3600)
);
--> statement-breakpoint
INSERT INTO `__new_rate_probe_configs`("id", "rate_id", "site_id", "model_mode", "model", "use_site_api_key", "key_mode", "custom_credential_type", "upstream_key_id", "upstream_key_managed", "max_output_tokens", "enabled", "interval_seconds", "retry_count", "retry_interval_seconds", "next_run_at", "last_run_at", "auto_create_quota_limit", "auto_create_expires_in_seconds", "created_at", "updated_at") SELECT "id", "rate_id", "site_id", "model_mode", "model", "use_site_api_key", "key_mode", "custom_credential_type", "upstream_key_id", "upstream_key_managed", "max_output_tokens", "enabled", "interval_seconds", "retry_count", "retry_interval_seconds", "next_run_at", "last_run_at", "auto_create_quota_limit", "auto_create_expires_in_seconds", "created_at", "updated_at" FROM `rate_probe_configs`;--> statement-breakpoint
DROP TABLE `rate_probe_configs`;--> statement-breakpoint
ALTER TABLE `__new_rate_probe_configs` RENAME TO `rate_probe_configs`;--> statement-breakpoint
UPDATE `rate_probe_runs`
SET `config_id` = (
	SELECT `config_id`
	FROM `__rate_probe_run_config_links`
	WHERE `run_id` = `rate_probe_runs`.`id`
)
WHERE `id` IN (SELECT `run_id` FROM `__rate_probe_run_config_links`);--> statement-breakpoint
DROP TABLE `__rate_probe_run_config_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `rate_probe_configs_rate_uq` ON `rate_probe_configs` (`rate_id`);--> statement-breakpoint
CREATE INDEX `rate_probe_configs_site_idx` ON `rate_probe_configs` (`site_id`);--> statement-breakpoint
CREATE INDEX `rate_probe_configs_due_idx` ON `rate_probe_configs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TRIGGER `rate_probe_configs_schedule_insert_ck`
BEFORE INSERT ON `rate_probe_configs`
WHEN NEW.`key_mode` NOT IN ('bound','existing','auto_create','manual')
	OR NEW.`interval_seconds` < 60
	OR NEW.`interval_seconds` > 8000000000000
	OR NEW.`interval_seconds` % 60 != 0
BEGIN
	SELECT RAISE(ABORT, 'invalid rate probe schedule');
END;--> statement-breakpoint
CREATE TRIGGER `rate_probe_configs_schedule_update_ck`
BEFORE UPDATE OF `key_mode`,`interval_seconds` ON `rate_probe_configs`
WHEN NEW.`key_mode` NOT IN ('bound','existing','auto_create','manual')
	OR NEW.`interval_seconds` < 60
	OR NEW.`interval_seconds` > 8000000000000
	OR NEW.`interval_seconds` % 60 != 0
BEGIN
	SELECT RAISE(ABORT, 'invalid rate probe schedule');
END;--> statement-breakpoint
INSERT OR IGNORE INTO `notification_rule_revisions` (
	`id`, `rule_id`, `revision_number`, `scope_json`, `condition_json`,
	`trigger_confirm_count`, `recovery_confirm_count`, `confirmation_duration_seconds`,
	`digest_window_seconds`, `cooldown_seconds`, `repeat_interval_seconds`, `max_repeats`,
	`send_recovery`, `channel_ids_json`, `created_by_admin_id`, `created_at`
) VALUES (
	'rulerev_system_event_fallback_v2', 'rule_system_event_fallback', 2, '{}',
	'{"event_types":["site.network_unreachable","site.timeout","site.auth_expired","site.permission_denied","site.rate_limited","site.upstream_5xx","site.schema_incompatible","site.other_error","site.recovered","rate.changed","rate.added","rate.removed","probe.input_tokens_high","probe.unexpected_tool_calls","probe.prompt_interference","probe.model_mismatch","probe.failed","probe.recovered","balance.low"]}',
	1, 1, NULL, 0, 0, 0, 0, 0, '[]', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);--> statement-breakpoint
UPDATE `notification_rules`
SET `current_revision_id` = 'rulerev_system_event_fallback_v2',
	`enabled` = 1,
	`deleted_at` = NULL,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` = 'rule_system_event_fallback';--> statement-breakpoint
UPDATE `incidents`
SET `trigger_count` = CASE WHEN `trigger_count` < 1 THEN 1 ELSE `trigger_count` END,
	`recovery_count` = 0
WHERE `event_type` IN ('rate.changed', 'rate.added', 'rate.removed')
	AND `deleted_at` IS NULL;--> statement-breakpoint
UPDATE `incidents`
SET `state` = 'resolved',
	`active_fingerprint` = NULL,
	`resolved_at` = COALESCE(`resolved_at`, `last_observed_at`, `updated_at`),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `event_type` IN ('rate.changed', 'rate.added', 'rate.removed')
	AND `active_fingerprint` IS NOT NULL
	AND `state` IN ('pending', 'firing', 'acknowledged', 'recovering');
