ALTER TABLE `incidents` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `incidents_active_time_idx` ON `incidents` (`deleted_at`,`last_observed_at`);