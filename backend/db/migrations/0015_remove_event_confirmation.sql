UPDATE `incidents`
SET
  `state` = 'firing',
  `fired_at` = COALESCE(`fired_at`, `first_observed_at`),
  `acknowledged_at` = NULL,
  `acknowledged_by_admin_id` = NULL,
  `resolved_at` = NULL
WHERE `state` IN ('pending', 'acknowledged');--> statement-breakpoint

WITH RECURSIVE `deleted_incidents`(`id`) AS (
  SELECT `id` FROM `incidents` WHERE `deleted_at` IS NOT NULL
  UNION
  SELECT `incidents`.`id`
  FROM `incidents`
  INNER JOIN `deleted_incidents`
    ON `incidents`.`suppressed_by_incident_id` = `deleted_incidents`.`id`
)
DELETE FROM `incidents`
WHERE `id` IN (SELECT `id` FROM `deleted_incidents`);--> statement-breakpoint

DELETE FROM `audit_logs` WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
DELETE FROM `maintenance_windows` WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
DELETE FROM `silences` WHERE `deleted_at` IS NOT NULL;
