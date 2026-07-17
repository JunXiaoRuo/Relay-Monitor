ALTER TABLE `notification_channels` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `notification_rules` ADD `deleted_at` text;
