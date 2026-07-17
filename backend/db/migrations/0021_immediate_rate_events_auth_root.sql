-- Candidate counters are retained as compatibility columns, but rate changes now
-- become effective on the first complete post-baseline snapshot.
UPDATE `rates_current`
SET `candidate_value` = NULL,
	`candidate_count` = 0,
	`missing_count` = 0
WHERE `candidate_value` IS NOT NULL
	OR `candidate_count` <> 0
	OR `missing_count` <> 0;
--> statement-breakpoint

-- Choose one active authentication incident per site and rule revision. Prefer an
-- existing auth resource, then the oldest observation, and merge counters without
-- multiplying one outage by the number of monitor tasks that observed it.
UPDATE `incidents` AS `root`
SET `resource_key` = 'auth',
	`trigger_count` = (
		SELECT MAX(`candidate`.`trigger_count`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	),
	`recovery_count` = (
		SELECT MAX(`candidate`.`recovery_count`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	),
	`repeat_count` = (
		SELECT MAX(`candidate`.`repeat_count`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	),
	`first_observed_at` = (
		SELECT MIN(`candidate`.`first_observed_at`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	),
	`fired_at` = COALESCE((
		SELECT MIN(`candidate`.`fired_at`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	), `root`.`fired_at`),
	`last_observed_at` = (
		SELECT MAX(`candidate`.`last_observed_at`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	),
	`last_notified_at` = COALESCE((
		SELECT MAX(`candidate`.`last_notified_at`)
		FROM `incidents` AS `candidate`
		WHERE `candidate`.`deleted_at` IS NULL
			AND `candidate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `candidate`.`site_id` IS `root`.`site_id`
			AND `candidate`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `candidate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	), `root`.`last_notified_at`),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `root`.`deleted_at` IS NULL
	AND `root`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
	AND `root`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	AND `root`.`id` = (
		SELECT `chosen`.`id`
		FROM `incidents` AS `chosen`
		WHERE `chosen`.`deleted_at` IS NULL
			AND `chosen`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `chosen`.`site_id` IS `root`.`site_id`
			AND `chosen`.`rule_revision_id` = `root`.`rule_revision_id`
			AND `chosen`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
		ORDER BY CASE WHEN `chosen`.`resource_key` = 'auth' THEN 0 ELSE 1 END,
			`chosen`.`first_observed_at`,
			`chosen`.`id`
		LIMIT 1
	);
--> statement-breakpoint

UPDATE `incidents` AS `duplicate`
SET `state` = 'suppressed',
	`active_fingerprint` = NULL,
	`suppressed_by_incident_id` = (
		SELECT `root`.`id`
		FROM `incidents` AS `root`
		WHERE `root`.`deleted_at` IS NULL
			AND `root`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `root`.`site_id` IS `duplicate`.`site_id`
			AND `root`.`rule_revision_id` = `duplicate`.`rule_revision_id`
			AND `root`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
		ORDER BY CASE WHEN `root`.`resource_key` = 'auth' THEN 0 ELSE 1 END,
			`root`.`first_observed_at`,
			`root`.`id`
		LIMIT 1
	),
	`suppression_reason` = 'auth_root_cause_merged',
	`resolved_at` = COALESCE(`duplicate`.`resolved_at`, `duplicate`.`last_observed_at`),
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `duplicate`.`deleted_at` IS NULL
	AND `duplicate`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
	AND `duplicate`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
	AND `duplicate`.`id` <> (
		SELECT `root`.`id`
		FROM `incidents` AS `root`
		WHERE `root`.`deleted_at` IS NULL
			AND `root`.`state` IN ('pending', 'firing', 'acknowledged', 'recovering')
			AND `root`.`site_id` IS `duplicate`.`site_id`
			AND `root`.`rule_revision_id` = `duplicate`.`rule_revision_id`
			AND `root`.`event_type` IN ('site.auth_expired', 'site.permission_denied')
		ORDER BY CASE WHEN `root`.`resource_key` = 'auth' THEN 0 ELSE 1 END,
			`root`.`first_observed_at`,
			`root`.`id`
		LIMIT 1
	);
