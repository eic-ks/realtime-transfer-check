DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,
  from_label TEXT NOT NULL DEFAULT '',
  to_label TEXT NOT NULL DEFAULT '',
  station TEXT,
  line TEXT,
  base_walk_min INTEGER,
  access_min INTEGER,
  ride_min INTEGER,
  departures TEXT,
  lat REAL,
  lng REAL
);
--> statement-breakpoint
CREATE TABLE walk_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  planned_min REAL NOT NULL,
  actual_min REAL NOT NULL,
  recorded_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE line_status (
  line TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  delay_min INTEGER,
  manual_delay_min INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  source_title TEXT,
  fetched_at INTEGER
);
--> statement-breakpoint
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY,
  active_route_id INTEGER
);
