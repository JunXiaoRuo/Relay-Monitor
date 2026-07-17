CREATE INDEX `rate_probe_configs_due_idx` ON `rate_probe_configs` (`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_probe_runs_one_running_site_uq`
ON `rate_probe_runs` (`site_id`)
WHERE `status` = 'running';
