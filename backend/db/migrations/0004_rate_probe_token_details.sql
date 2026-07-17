ALTER TABLE `rate_probe_runs` ADD `cached_input_tokens` integer CHECK (`cached_input_tokens` is null or `cached_input_tokens` >= 0);--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `reasoning_tokens` integer CHECK (`reasoning_tokens` is null or `reasoning_tokens` >= 0);--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `expected_input_tokens` integer CHECK (`expected_input_tokens` is null or `expected_input_tokens` >= 0);--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `input_token_delta` integer;--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `input_token_assessment` text DEFAULT 'unknown' NOT NULL CHECK (`input_token_assessment` in ('within_expected','higher_than_expected','unknown'));--> statement-breakpoint
ALTER TABLE `rate_probe_runs` ADD `tool_calls_observed` integer DEFAULT false NOT NULL;
