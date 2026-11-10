// Drizzle schema for the real-time transfer guide.
//
// Routes are user-owned: a route is an ordered list of segments
// (origin / walk / ride). Ride segments carry the user's own timetable
// (departure minutes-of-day for weekday / holiday day-parts) because no
// importable nationwide timetable source exists. Walk segments carry a
// base walking time; recorded walk logs let the app learn the user's
// personal pace per segment. Line status rows cache the latest delay
// lookup fetched from official operator pages via web search.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const routes = sqliteTable("routes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  bufferMin: integer("buffer_min").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const segments = sqliteTable("segments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routeId: integer("route_id").notNull(),
  position: integer("position").notNull(),
  type: text("type", { enum: ["origin", "walk", "ride"] }).notNull(),
  fromLabel: text("from_label").notNull().default(""),
  toLabel: text("to_label").notNull().default(""),
  station: text("station"),
  line: text("line"),
  baseWalkMin: integer("base_walk_min"),
  accessMin: integer("access_min"),
  rideMin: integer("ride_min"),
  // JSON: {"weekday": number[], "holiday": number[]} — minutes of day.
  departures: text("departures"),
  lat: real("lat"),
  lng: real("lng"),
  // Place registration (address / spot-name search / map pin). Coordinates
  // are internal only — the UI never shows raw latitude/longitude.
  // placeName/placeAddress describe the segment's start point (origin
  // place / boarding station); toPlace* the end point (destination /
  // alighting station). For walk segments these hold the from/to places.
  placeName: text("place_name"),
  placeAddress: text("place_address"),
  toPlaceName: text("to_place_name"),
  toPlaceAddress: text("to_place_address"),
  toLat: real("to_lat"),
  toLng: real("to_lng"),
  // Return-direction timetable for ride segments, same JSON shape as
  // `departures`. Routes are bidirectional: one route covers both the
  // outward and the return trip; only the timetable differs per direction.
  departuresReturn: text("departures_return"),
});

export const walkLogs = sqliteTable("walk_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routeId: integer("route_id").notNull(),
  segmentId: integer("segment_id").notNull(),
  plannedMin: real("planned_min").notNull(),
  actualMin: real("actual_min").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const lineStatus = sqliteTable("line_status", {
  line: text("line").primaryKey(),
  status: text("status", {
    enum: ["normal", "delayed", "suspended", "unknown"],
  })
    .notNull()
    .default("unknown"),
  delayMin: integer("delay_min"),
  manualDelayMin: integer("manual_delay_min"),
  summary: text("summary").notNull().default(""),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }),
});

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  activeRouteId: integer("active_route_id"),
  // Travel direction on the active (bidirectional) route, auto-detected
  // from GPS position/movement. "manual" source marks a user correction
  // that auto-detection must not override for the rest of the session.
  direction: text("direction", { enum: ["outbound", "return"] }),
  directionSource: text("direction_source"),
});
