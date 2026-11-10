CREATE TABLE `train_timetable_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`line` text NOT NULL,
	`station` text NOT NULL,
	`toward` text NOT NULL,
	`weekday_trains` text,
	`holiday_trains` text,
	`source_url` text,
	`source_title` text,
	`fetched_at` integer
);
--> statement-breakpoint
CREATE TABLE `train_detail_cache` (
	`train_key` text PRIMARY KEY NOT NULL,
	`line` text NOT NULL,
	`train_type` text NOT NULL DEFAULT '',
	`dest` text NOT NULL DEFAULT '',
	`stops` text,
	`fetched_at` integer
);
