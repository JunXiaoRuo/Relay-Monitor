CREATE TABLE `server_access_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`tls_enabled` integer DEFAULT false NOT NULL,
	`access_host` text NOT NULL,
	`tls_material_id` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "server_access_settings_singleton_ck" CHECK("server_access_settings"."id" = 'global'),
	CONSTRAINT "server_access_settings_host_ck" CHECK(length(trim("server_access_settings"."access_host")) > 0)
);
