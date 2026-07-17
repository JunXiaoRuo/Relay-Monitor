ALTER TABLE `monitor_configs` ADD `retry_count` integer DEFAULT 0 NOT NULL
  CONSTRAINT `monitor_configs_retry_count_ck` CHECK (`retry_count` >= 0 AND `retry_count` <= 10);
--> statement-breakpoint
ALTER TABLE `monitor_configs` ADD `retry_interval_seconds` integer DEFAULT 0 NOT NULL
  CONSTRAINT `monitor_configs_retry_interval_ck` CHECK (`retry_interval_seconds` >= 0 AND `retry_interval_seconds` <= 3600);
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `retry_count` integer DEFAULT 0 NOT NULL
  CONSTRAINT `rate_probe_configs_retry_count_ck` CHECK (`retry_count` >= 0 AND `retry_count` <= 10);
--> statement-breakpoint
ALTER TABLE `rate_probe_configs` ADD `retry_interval_seconds` integer DEFAULT 0 NOT NULL
  CONSTRAINT `rate_probe_configs_retry_interval_ck` CHECK (`retry_interval_seconds` >= 0 AND `retry_interval_seconds` <= 3600);
--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `attempt_count` integer DEFAULT 1 NOT NULL
  CONSTRAINT `rate_probe_runs_attempt_count_ck` CHECK (`attempt_count` >= 1);
--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `heartbeat_at` text;
--> statement-breakpoint
INSERT OR IGNORE INTO `notification_rules` (
  `id`, `name`, `type`, `enabled`, `severity`, `current_revision_id`, `created_at`, `updated_at`, `deleted_at`
) VALUES (
  'rule_system_event_fallback', '系统事件兜底', 'monitor_events', 1, 'warning', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `notification_rule_revisions` (
  `id`, `rule_id`, `revision_number`, `scope_json`, `condition_json`,
  `trigger_confirm_count`, `recovery_confirm_count`, `confirmation_duration_seconds`,
  `digest_window_seconds`, `cooldown_seconds`, `repeat_interval_seconds`, `max_repeats`,
  `send_recovery`, `channel_ids_json`, `created_by_admin_id`, `created_at`
) VALUES (
  'rulerev_system_event_fallback_v1', 'rule_system_event_fallback', 1, '{}',
  '{"event_types":["site.network_unreachable","site.timeout","site.auth_expired","site.permission_denied","site.rate_limited","site.upstream_5xx","site.schema_incompatible","site.other_error","site.recovered","rate.changed","rate.added","rate.removed","probe.input_tokens_high","probe.unexpected_tool_calls","probe.prompt_interference","probe.model_mismatch","probe.failed","probe.recovered"]}',
  1, 1, NULL, 0, 0, 0, 0, 0, '[]', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
--> statement-breakpoint
UPDATE `notification_rules`
SET `current_revision_id` = 'rulerev_system_event_fallback_v1',
    `enabled` = 1,
    `deleted_at` = NULL,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` = 'rule_system_event_fallback';
