UPDATE `notification_channels`
SET `headers_json` = '{}'
WHERE `secret_type` IS NULL OR `secret_type` <> 'headers_json';--> statement-breakpoint

UPDATE `notification_channels`
SET `allowed_cidrs_json` = '[]'
WHERE `allowed_cidrs_json` <> '[]';
