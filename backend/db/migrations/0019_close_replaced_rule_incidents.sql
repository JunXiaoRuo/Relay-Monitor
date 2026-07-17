UPDATE `incidents`
SET `state` = 'suppressed',
	`active_fingerprint` = NULL,
	`suppression_reason` = 'rule_revision_replaced',
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `deleted_at` IS NULL
	AND `state` IN ('pending', 'firing', 'acknowledged', 'recovering')
	AND EXISTS (
		SELECT 1
		FROM `notification_rule_revisions` AS `incident_revision`
		INNER JOIN `notification_rules` AS `rule`
			ON `rule`.`id` = `incident_revision`.`rule_id`
		INNER JOIN `notification_rule_revisions` AS `current_revision`
			ON `current_revision`.`id` = `rule`.`current_revision_id`
			AND `current_revision`.`rule_id` = `rule`.`id`
		WHERE `incident_revision`.`id` = `incidents`.`rule_revision_id`
			AND `current_revision`.`id` <> `incident_revision`.`id`
	);
