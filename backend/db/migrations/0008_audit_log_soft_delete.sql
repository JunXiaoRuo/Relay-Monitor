ALTER TABLE `audit_logs` ADD `deleted_at` text;
--> statement-breakpoint
CREATE INDEX `audit_logs_active_time_idx` ON `audit_logs` (`deleted_at`,`created_at`);
