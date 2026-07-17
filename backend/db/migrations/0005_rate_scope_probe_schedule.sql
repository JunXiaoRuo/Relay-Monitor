ALTER TABLE `sites` ADD `rate_group_scope_mode` text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sites` ADD `rate_group_ids_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sites` ADD `excluded_rate_group_ids_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `key_mode` text DEFAULT 'bound' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `upstream_key_id` text;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `upstream_key_managed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `interval_seconds` integer DEFAULT 3600 NOT NULL;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `next_run_at` text;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `last_run_at` text;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `auto_create_quota_limit` text;
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `auto_create_expires_in_seconds` integer;
--> statement-breakpoint
UPDATE `rate_probe_configs`
SET `key_mode` = 'manual'
WHERE `use_site_api_key` = false;
--> statement-breakpoint
CREATE TABLE `site_probe_key_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`group_id` text NOT NULL,
	`key_mode` text NOT NULL,
	`upstream_key_id` text,
	`upstream_key_managed` integer DEFAULT false NOT NULL,
	`credential_type` text NOT NULL,
	`quota_limit` text,
	`expires_in_seconds` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_probe_key_mappings_mode_ck" CHECK("site_probe_key_mappings"."key_mode" in ('existing','auto_create'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_probe_key_mappings_site_group_uq` ON `site_probe_key_mappings` (`site_id`,`group_id`);
--> statement-breakpoint
CREATE INDEX `site_probe_key_mappings_site_idx` ON `site_probe_key_mappings` (`site_id`);
