ALTER TABLE `notification_channels`
ADD `body_mode` text DEFAULT 'json' NOT NULL
CONSTRAINT `notification_channels_body_mode_ck`
CHECK (`body_mode` IN ('json', 'form_data', 'custom'));--> statement-breakpoint

UPDATE `notification_channels`
SET
	`headers_json` = '{}',
	`allowed_cidrs_json` = '[]'
WHERE `secret_type` IS NULL OR `secret_type` <> 'headers_json';--> statement-breakpoint

UPDATE `notification_channels`
SET `allowed_cidrs_json` = '[]'
WHERE `allowed_cidrs_json` <> '[]';
