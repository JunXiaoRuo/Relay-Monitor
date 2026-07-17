UPDATE `rates_current`
SET `candidate_value` = NULL,
	`candidate_count` = 0,
	`missing_count` = 0
WHERE `candidate_value` IS NOT NULL
	OR `candidate_count` <> 0
	OR `missing_count` <> 0;
--> statement-breakpoint

DROP TABLE IF EXISTS `_relay_monitor_0022_auth_roots`;
--> statement-breakpoint

CREATE TEMP TABLE `_relay_monitor_0022_auth_roots` AS
SELECT
	`grouped`.`site_id` AS `site_id`,
	`grouped`.`rule_revision_id` AS `rule_revision_id`,
	(
		SELECT `chosen`.`id`
		FROM `incidents` AS `chosen`
		WHERE `chosen`.`deleted_at` IS NULL
			AND `chosen`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `chosen`.`site_id` IS `grouped`.`site_id`
			AND `chosen`.`rule_revision_id` = `grouped`.`rule_revision_id`
			AND `chosen`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
		ORDER BY CASE WHEN `chosen`.`resource_key` = 'auth' THEN 0 ELSE 1 END,
			`chosen`.`first_observed_at`,
			`chosen`.`id`
		LIMIT 1
	) AS `root_id`,
	`grouped`.`trigger_count` AS `trigger_count`,
	`grouped`.`recovery_count` AS `recovery_count`,
	`grouped`.`repeat_count` AS `repeat_count`,
	`grouped`.`first_observed_at` AS `first_observed_at`,
	`grouped`.`fired_at` AS `fired_at`,
	`grouped`.`last_observed_at` AS `last_observed_at`,
	`grouped`.`last_notified_at` AS `last_notified_at`
FROM (
	SELECT
		`site_id`,
		`rule_revision_id`,
		MAX(`trigger_count`) AS `trigger_count`,
		MAX(`recovery_count`) AS `recovery_count`,
		MAX(`repeat_count`) AS `repeat_count`,
		MIN(`first_observed_at`) AS `first_observed_at`,
		MIN(`fired_at`) AS `fired_at`,
		MAX(`last_observed_at`) AS `last_observed_at`,
		MAX(`last_notified_at`) AS `last_notified_at`
	FROM `incidents`
	WHERE `deleted_at` IS NULL
		AND `state` IN ('pending', 'firing', 'acknowledged', 'recovering')
		AND `event_type` IN ('site.auth_expired', 'site.permission_denied')
	GROUP BY `site_id`, `rule_revision_id`
) AS `grouped`;
--> statement-breakpoint

UPDATE `incidents`
SET `resource_key` = 'auth',
	`trigger_count` = (
		SELECT `roots`.`trigger_count`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	),
	`recovery_count` = (
		SELECT `roots`.`recovery_count`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	),
	`repeat_count` = (
		SELECT `roots`.`repeat_count`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	),
	`first_observed_at` = (
		SELECT `roots`.`first_observed_at`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	),
	`fired_at` = COALESCE((
		SELECT `roots`.`fired_at`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	), `fired_at`),
	`last_observed_at` = (
		SELECT `roots`.`last_observed_at`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	),
	`last_notified_at` = COALESCE((
		SELECT `roots`.`last_notified_at`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`root_id` = `incidents`.`id`
	), `last_notified_at`),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` IN (SELECT `root_id` FROM `_relay_monitor_0022_auth_roots`);
--> statement-breakpoint

UPDATE `incidents` AS `duplicate`
SET `state` = 'suppressed',
	`active_fingerprint` = NULL,
	`suppressed_by_incident_id` = (
		SELECT `roots`.`root_id`
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`site_id` IS `duplicate`.`site_id`
			AND `roots`.`rule_revision_id` = `duplicate`.`rule_revision_id`
	),
	`suppression_reason` = 'auth_root_cause_merged',
	`resolved_at` = COALESCE(`duplicate`.`resolved_at`, `duplicate`.`last_observed_at`),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `duplicate`.`deleted_at` IS NULL
	AND `duplicate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
	AND `duplicate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	AND EXISTS (
		SELECT 1
		FROM `_relay_monitor_0022_auth_roots` AS `roots`
		WHERE `roots`.`site_id` IS `duplicate`.`site_id`
			AND `roots`.`rule_revision_id` = `duplicate`.`rule_revision_id`
			AND `roots`.`root_id` <> `duplicate`.`id`
	);
--> statement-breakpoint

DROP TABLE `_relay_monitor_0022_auth_roots`;
