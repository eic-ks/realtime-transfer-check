CREATE TABLE `gtfs_feed_cache` (
	`feed_key` text PRIMARY KEY NOT NULL,
	`org_name` text DEFAULT '' NOT NULL,
	`feed_name` text DEFAULT '' NOT NULL,
	`license_name` text,
	`page_url` text,
	`routes` text,
	`fetched_at` integer
);
--> statement-breakpoint
CREATE TABLE `gtfs_line_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`feed_key` text NOT NULL,
	`route_id` text NOT NULL,
	`route_name` text DEFAULT '' NOT NULL,
	`direction_id` integer NOT NULL,
	`toward` text DEFAULT '' NOT NULL,
	`stops` text,
	`fetched_at` integer
);
--> statement-breakpoint
CREATE TABLE `gtfs_departures` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`feed_key` text NOT NULL,
	`route_id` text NOT NULL,
	`direction_id` integer NOT NULL,
	`stop_core` text NOT NULL,
	`weekday` text,
	`holiday` text
);
