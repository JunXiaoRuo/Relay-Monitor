CREATE TABLE `rate_probe_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`rate_id` text NOT NULL,
	`site_id` text NOT NULL,
	`model_mode` text DEFAULT 'auto' NOT NULL,
	`model` text,
	`use_site_api_key` integer DEFAULT true NOT NULL,
	`custom_credential_type` text,
	`max_output_tokens` integer DEFAULT 96 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`rate_id`) REFERENCES `rates_current`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rate_probe_configs_model_mode_ck" CHECK("rate_probe_configs"."model_mode" in ('auto','manual')),
	CONSTRAINT "rate_probe_configs_max_tokens_ck" CHECK("rate_probe_configs"."max_output_tokens" >= 1 and "rate_probe_configs"."max_output_tokens" <= 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_probe_configs_rate_uq` ON `rate_probe_configs` (`rate_id`);--> statement-breakpoint
CREATE INDEX `rate_probe_configs_site_idx` ON `rate_probe_configs` (`site_id`);--> statement-breakpoint
CREATE TABLE `rate_probe_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text,
	`rate_id` text NOT NULL,
	`site_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`requested_model` text NOT NULL,
	`returned_model` text,
	`ttfb_ms` integer,
	`ttft_ms` integer,
	`total_ms` integer,
	`generation_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`tps` text,
	`finish_reason` text,
	`system_fingerprint` text,
	`prompt_integrity` text DEFAULT 'unknown' NOT NULL,
	`knowledge_probe` text DEFAULT 'unknown' NOT NULL,
	`model_identity` text DEFAULT 'unknown' NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`response_hash` text,
	`http_status` integer,
	`error_code` text,
	`error_message` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `rate_probe_configs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rate_id`) REFERENCES `rates_current`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rate_probe_runs_status_ck" CHECK("rate_probe_runs"."status" in ('running','succeeded','failed')),
	CONSTRAINT "rate_probe_runs_prompt_integrity_ck" CHECK("rate_probe_runs"."prompt_integrity" in ('no_interference_observed','suspected','unknown')),
	CONSTRAINT "rate_probe_runs_knowledge_probe_ck" CHECK("rate_probe_runs"."knowledge_probe" in ('weak_consistency','suspicious','not_applicable','unknown')),
	CONSTRAINT "rate_probe_runs_model_identity_ck" CHECK("rate_probe_runs"."model_identity" in ('declared_match','declared_mismatch','unknown')),
	CONSTRAINT "rate_probe_runs_ttfb_ck" CHECK("rate_probe_runs"."ttfb_ms" is null or "rate_probe_runs"."ttfb_ms" >= 0),
	CONSTRAINT "rate_probe_runs_ttft_ck" CHECK("rate_probe_runs"."ttft_ms" is null or "rate_probe_runs"."ttft_ms" >= 0),
	CONSTRAINT "rate_probe_runs_total_ck" CHECK("rate_probe_runs"."total_ms" is null or "rate_probe_runs"."total_ms" >= 0),
	CONSTRAINT "rate_probe_runs_generation_ck" CHECK("rate_probe_runs"."generation_ms" is null or "rate_probe_runs"."generation_ms" >= 0),
	CONSTRAINT "rate_probe_runs_tokens_ck" CHECK(("rate_probe_runs"."prompt_tokens" is null or "rate_probe_runs"."prompt_tokens" >= 0) and ("rate_probe_runs"."completion_tokens" is null or "rate_probe_runs"."completion_tokens" >= 0) and ("rate_probe_runs"."total_tokens" is null or "rate_probe_runs"."total_tokens" >= 0))
);
--> statement-breakpoint
CREATE INDEX `rate_probe_runs_rate_time_idx` ON `rate_probe_runs` (`rate_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `rate_probe_runs_site_time_idx` ON `rate_probe_runs` (`site_id`,`started_at`);