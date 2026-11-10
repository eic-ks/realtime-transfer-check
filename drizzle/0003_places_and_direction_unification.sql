ALTER TABLE segments ADD COLUMN place_name TEXT;
--> statement-breakpoint
ALTER TABLE segments ADD COLUMN place_address TEXT;
--> statement-breakpoint
ALTER TABLE segments ADD COLUMN to_place_name TEXT;
--> statement-breakpoint
ALTER TABLE segments ADD COLUMN to_place_address TEXT;
--> statement-breakpoint
ALTER TABLE segments ADD COLUMN to_lat REAL;
--> statement-breakpoint
ALTER TABLE segments ADD COLUMN to_lng REAL;
--> statement-breakpoint
ALTER TABLE segments ADD COLUMN departures_return TEXT;
--> statement-breakpoint
ALTER TABLE app_settings ADD COLUMN direction TEXT;
--> statement-breakpoint
ALTER TABLE app_settings ADD COLUMN direction_source TEXT;
