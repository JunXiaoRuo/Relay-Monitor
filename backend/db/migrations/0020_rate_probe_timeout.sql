ALTER TABLE `rate_probe_configs`
ADD `timeout_seconds` integer DEFAULT 30 NOT NULL
CONSTRAINT `rate_probe_configs_timeout_ck`
CHECK (`timeout_seconds` >= 1 AND `timeout_seconds` <= 300);
