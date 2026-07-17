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
	CONSTRAINT "rate_probe_configs_interval_ck" CHECK("__new_rate_probe_configs"."interval_seconds" >= 900 and "__new_rate_probe_configs"."interval_seconds" <= 86400),
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
	OR NEW.`interval_seconds` < 900
	OR NEW.`interval_seconds` > 86400
BEGIN
	SELECT RAISE(ABORT, 'invalid rate probe schedule');
END;--> statement-breakpoint
CREATE TRIGGER `rate_probe_configs_schedule_update_ck`
BEFORE UPDATE OF `key_mode`,`interval_seconds` ON `rate_probe_configs`
WHEN NEW.`key_mode` NOT IN ('bound','existing','auto_create','manual')
	OR NEW.`interval_seconds` < 900
	OR NEW.`interval_seconds` > 86400
BEGIN
	SELECT RAISE(ABORT, 'invalid rate probe schedule');
END;
