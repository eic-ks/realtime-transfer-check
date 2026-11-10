CREATE TABLE `timetable_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line` text NOT NULL,
	`station` text NOT NULL,
	`toward` text NOT NULL,
	`weekday` text,
	`holiday` text,
	`source_url` text,
	`source_title` text,
	`fetched_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `timetable_cache_key` ON `timetable_cache` (`line`,`station`,`toward`);
