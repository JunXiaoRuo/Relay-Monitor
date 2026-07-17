CREATE TEMP TABLE `_relay_route_rule_revision_migration` (
	`rule_id` text PRIMARY KEY NOT NULL,
	`old_revision_id` text NOT NULL,
	`new_revision_id` text NOT NULL,
	`new_revision_number` integer NOT NULL,
	`channel_ids_json` text NOT NULL
);--> statement-breakpoint
WITH `active_route_channels` AS (
	SELECT DISTINCT `channel`.`id` AS `channel_id`
	FROM `notification_routes` AS `route`
	JOIN json_each(
		CASE
			WHEN json_valid(`route`.`channel_ids_json`) THEN `route`.`channel_ids_json`
			ELSE '[]'
		END
	) AS `route_channel`
	JOIN `notification_channels` AS `channel`
		ON `channel`.`id` = CAST(`route_channel`.`value` AS text)
	WHERE `route`.`enabled` = 1
		AND `route`.`deleted_at` IS NULL
		AND json_valid(`route`.`channel_ids_json`) = 1
		AND json_type(`route`.`channel_ids_json`) = 'array'
		AND `route_channel`.`type` = 'text'
		AND `channel`.`deleted_at` IS NULL
		AND (
			SELECT count(*)
			FROM `notification_routes` AS `active_route`
			WHERE `active_route`.`enabled` = 1
				AND `active_route`.`deleted_at` IS NULL
		) = 1
		AND json_valid(`route`.`matcher_json`) = 1
		AND json_type(`route`.`matcher_json`) = 'object'
		AND NOT EXISTS (
			SELECT 1
			FROM json_each(`route`.`matcher_json`)
		)
),
`default_channels` AS (
	SELECT json_group_array(`channel_id`) AS `channel_ids_json`
	FROM `active_route_channels`
)
INSERT INTO `_relay_route_rule_revision_migration` (
	`rule_id`,
	`old_revision_id`,
	`new_revision_id`,
	`new_revision_number`,
	`channel_ids_json`
)
SELECT
	`rule`.`id`,
	`revision`.`id`,
	'rulerev_migration_' || lower(hex(randomblob(16))),
	(
		SELECT max(`existing_revision`.`revision_number`) + 1
		FROM `notification_rule_revisions` AS `existing_revision`
		WHERE `existing_revision`.`rule_id` = `rule`.`id`
	),
	`default_channels`.`channel_ids_json`
FROM `notification_rules` AS `rule`
JOIN `notification_rule_revisions` AS `revision`
	ON `revision`.`id` = `rule`.`current_revision_id`
	AND `revision`.`rule_id` = `rule`.`id`
CROSS JOIN `default_channels`
WHERE `rule`.`deleted_at` IS NULL
	AND EXISTS (SELECT 1 FROM `active_route_channels`)
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(
			CASE
				WHEN json_valid(`revision`.`channel_ids_json`)
					THEN `revision`.`channel_ids_json`
				ELSE '[]'
			END
		)
		WHERE `type` = 'text'
	);--> statement-breakpoint
INSERT INTO `notification_rule_revisions` (
	`id`,
	`rule_id`,
	`revision_number`,
	`scope_json`,
	`condition_json`,
	`trigger_confirm_count`,
	`recovery_confirm_count`,
	`confirmation_duration_seconds`,
	`digest_window_seconds`,
	`cooldown_seconds`,
	`repeat_interval_seconds`,
	`max_repeats`,
	`send_recovery`,
	`channel_ids_json`,
	`created_by_admin_id`,
	`created_at`
)
SELECT
	`migration`.`new_revision_id`,
	`current_revision`.`rule_id`,
	`migration`.`new_revision_number`,
	`current_revision`.`scope_json`,
	`current_revision`.`condition_json`,
	`current_revision`.`trigger_confirm_count`,
	`current_revision`.`recovery_confirm_count`,
	`current_revision`.`confirmation_duration_seconds`,
	`current_revision`.`digest_window_seconds`,
	`current_revision`.`cooldown_seconds`,
	`current_revision`.`repeat_interval_seconds`,
	`current_revision`.`max_repeats`,
	`current_revision`.`send_recovery`,
	`migration`.`channel_ids_json`,
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `_relay_route_rule_revision_migration` AS `migration`
JOIN `notification_rule_revisions` AS `current_revision`
	ON `current_revision`.`id` = `migration`.`old_revision_id`;--> statement-breakpoint
UPDATE `incidents`
SET `state` = 'suppressed',
	`active_fingerprint` = NULL,
	`suppression_reason` = 'rule_revision_replaced',
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `rule_revision_id` IN (
	SELECT `old_revision_id`
	FROM `_relay_route_rule_revision_migration`
)
	AND `state` IN ('pending', 'firing', 'acknowledged', 'recovering');--> statement-breakpoint
UPDATE `notification_rules`
SET `current_revision_id` = (
		SELECT `migration`.`new_revision_id`
		FROM `_relay_route_rule_revision_migration` AS `migration`
		WHERE `migration`.`rule_id` = `notification_rules`.`id`
	),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` IN (
	SELECT `rule_id`
	FROM `_relay_route_rule_revision_migration`
);--> statement-breakpoint
DROP TABLE `_relay_route_rule_revision_migration`;--> statement-breakpoint
UPDATE `notification_routes`
SET `enabled` = 0,
	`deleted_at` = COALESCE(`deleted_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
