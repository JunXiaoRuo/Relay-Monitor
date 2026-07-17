PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_monitor_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`monitor_type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_seconds` integer DEFAULT 300 NOT NULL,
	`timeout_seconds` integer DEFAULT 15 NOT NULL,
	`retry_count` integer DEFAULT 1 NOT NULL,
	`retry_interval_seconds` integer DEFAULT 60 NOT NULL,
	`schedule_jitter_percent` integer DEFAULT 10 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monitor_configs_type_ck" CHECK("__new_monitor_configs"."monitor_type" in ('connectivity','rates','balance','auth')),
	CONSTRAINT "monitor_configs_interval_ck" CHECK("__new_monitor_configs"."interval_seconds" >= 10 and "__new_monitor_configs"."interval_seconds" <= 86400),
	CONSTRAINT "monitor_configs_timeout_ck" CHECK("__new_monitor_configs"."timeout_seconds" >= 1 and "__new_monitor_configs"."timeout_seconds" <= 120),
	CONSTRAINT "monitor_configs_retry_count_ck" CHECK("__new_monitor_configs"."retry_count" >= 0 and "__new_monitor_configs"."retry_count" <= 10),
	CONSTRAINT "monitor_configs_retry_interval_ck" CHECK("__new_monitor_configs"."retry_interval_seconds" >= 0 and "__new_monitor_configs"."retry_interval_seconds" <= 3600),
	CONSTRAINT "monitor_configs_jitter_ck" CHECK("__new_monitor_configs"."schedule_jitter_percent" >= 0 and "__new_monitor_configs"."schedule_jitter_percent" <= 50)
);
--> statement-breakpoint
INSERT INTO `__new_monitor_configs`("id", "site_id", "monitor_type", "enabled", "interval_seconds", "timeout_seconds", "retry_count", "retry_interval_seconds", "schedule_jitter_percent", "created_at", "updated_at") SELECT "id", "site_id", "monitor_type", "enabled", "interval_seconds", "timeout_seconds", "retry_count", "retry_interval_seconds", "schedule_jitter_percent", "created_at", "updated_at" FROM `monitor_configs`;--> statement-breakpoint
DROP TABLE `monitor_configs`;--> statement-breakpoint
ALTER TABLE `__new_monitor_configs` RENAME TO `monitor_configs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_configs_site_type_uq` ON `monitor_configs` (`site_id`,`monitor_type`);