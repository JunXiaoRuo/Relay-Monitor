UPDATE `rate_probe_runs`
SET `status` = 'failed',
	`prompt_integrity` = 'unknown',
	`knowledge_probe` = 'unknown',
	`model_identity` = 'unknown',
	`error_code` = 'RATE_PROBE_INTERRUPTED',
	`error_message` = 'Model probe was interrupted by a service restart',
	`completed_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` = 'running';
--> statement-breakpoint
CREATE TRIGGER `sites_rate_group_scope_insert_ck`
BEFORE INSERT ON `sites`
WHEN NEW.`rate_group_scope_mode` NOT IN ('all','selected')
BEGIN
	SELECT RAISE(ABORT, 'invalid rate_group_scope_mode');
END;
--> statement-breakpoint
CREATE TRIGGER `sites_rate_group_scope_update_ck`
BEFORE UPDATE OF `rate_group_scope_mode` ON `sites`
WHEN NEW.`rate_group_scope_mode` NOT IN ('all','selected')
BEGIN
	SELECT RAISE(ABORT, 'invalid rate_group_scope_mode');
END;
--> statement-breakpoint
CREATE TRIGGER `rate_probe_configs_schedule_insert_ck`
BEFORE INSERT ON `rate_probe_configs`
WHEN NEW.`key_mode` NOT IN ('bound','existing','auto_create','manual')
	OR NEW.`interval_seconds` < 900
	OR NEW.`interval_seconds` > 86400
BEGIN
	SELECT RAISE(ABORT, 'invalid rate probe schedule');
END;
--> statement-breakpoint
CREATE TRIGGER `rate_probe_configs_schedule_update_ck`
BEFORE UPDATE OF `key_mode`,`interval_seconds` ON `rate_probe_configs`
WHEN NEW.`key_mode` NOT IN ('bound','existing','auto_create','manual')
	OR NEW.`interval_seconds` < 900
	OR NEW.`interval_seconds` > 86400
BEGIN
	SELECT RAISE(ABORT, 'invalid rate probe schedule');
END;
