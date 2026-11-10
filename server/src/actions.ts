// Actions for the real-time transfer guide.
//
// Data model: the user registers routes (ordered origin/walk/ride
// segments with their own timetables). The client computes catchable
// trains every second from the stored timetable, learned walking times,
// and cached line-delay status. Delay status is fetched on demand from
// official operator pages via web search and classified with model
// inference; results are cached in `line_status` with their source URL.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------- shared zod shapes ----------

const departuresShape = z.object({
weekday: z.array(z.number().int().min(0).max(1560)).max(400),
holiday: z.array(z.number().int().min(0).max(1560)).max(400),
});

const segmentShape = z.object({
id: z.number(),
position: z.number(),
type: z.enum(["origin", "walk", "ride"]),
fromLabel: z.string(),
toLabel: z.string(),
station: z.string().nullable(),
line: z.string().nullable(),
baseWalkMin: z.number().nullable(),
accessMin: z.number().nullable(),
rideMin: z.number().nullable(),
departuresWeekday: z.array(z.number()),
departuresHoliday: z.array(z.number()),
lat: z.number().nullable(),
lng: z.number().nullable(),
placeName: z.string().nullable(),
placeAddress: z.string().nullable(),
toPlaceName: z.string().nullable(),
toPlaceAddress: z.string().nullable(),
toLat: z.number().nullable(),
toLng: z.number().nullable(),
returnWeekday: z.array(z.number()),
returnHoliday: z.array(z.number()),
learnedWalkMin: z.number().nullable(),
walkSamples: z.number(),
});

const routeShape = z.object({
id: z.number(),
name: z.string(),
bufferMin: z.number(),
segments: z.array(segmentShape),
});

const lineStatusShape = z.object({
line: z.string(),
status: z.enum(["normal", "delayed", "suspended", "unknown"]),
delayMin: z.number().nullable(),
manualDelayMin: z.number().nullable(),
summary: z.string(),
sourceUrl: z.string().nullable(),
sourceTitle: z.string().nullable(),
fetchedAt: z.string().nullable(),
});

const stateResponse = z.object({
activeRouteId: z.number().nullable(),
direction: z.enum(["outbound", "return"]).nullable(),
directionSource: z.string().nullable(),
routes: z.array(routeShape),
lineStatuses: z.array(lineStatusShape),
walkLogs: z.array(
z.object({
id: z.number(),
routeId: z.number(),
segmentId: z.number(),
plannedMin: z.number(),
actualMin: z.number(),
recordedAt: z.string(),
}),
),
});
type StateResponse = z.infer<typeof stateResponse>;

const segmentInput = z.object({
type: z.enum(["origin", "walk", "ride"]),
fromLabel: z.string().max(80),
toLabel: z.string().max(80),
station: z.string().max(80).nullable(),
line: z.string().max(80).nullable(),
baseWalkMin: z.number().int().min(0).max(240).nullable(),
accessMin: z.number().int().min(0).max(60).nullable(),
rideMin: z.number().int().min(0).max(600).nullable(),
departures: departuresShape.nullable(),
lat: z.number().min(-90).max(90).nullable(),
lng: z.number().min(-180).max(180).nullable(),
placeName: z.string().max(120).nullable(),
placeAddress: z.string().max(300).nullable(),
toPlaceName: z.string().max(120).nullable(),
toPlaceAddress: z.string().max(300).nullable(),
toLat: z.number().min(-90).max(90).nullable(),
toLng: z.number().min(-180).max(180).nullable(),
departuresReturn: departuresShape.nullable(),
});

// ---------- helpers ----------

function parseDepartures(raw: string | null): {
weekday: number[];
holiday: number[];
} {
if (!raw) return { weekday: [], holiday: []};
try {
const parsed = JSON.parse(raw) as {
weekday?: unknown;
holiday?: unknown;
};
const clean = (v: unknown): number[] =>
Array.isArray(v)
? v.filter((n): n is number => typeof n === "number" && n >= 0)
: [];
return { weekday: clean(parsed.weekday), holiday: clean(parsed.holiday)};
} catch {
return { weekday: [], holiday: []};
}
}

async function loadState(ctx: Ctx): Promise<StateResponse> {
const db = ctx.db<typeof schema>();
const routeRows = await db
.select()
.from(schema.routes)
.orderBy(asc(schema.routes.id));
const segmentRows = await db
.select()
.from(schema.segments)
.orderBy(asc(schema.segments.position));
const logRows = await db
.select()
.from(schema.walkLogs)
.orderBy(desc(schema.walkLogs.id))
.limit(200);
const statusRows = await db.select().from(schema.lineStatus);
const settingRows = await db
.select()
.from(schema.appSettings)
.where(eq(schema.appSettings.id, 1));
const setting = settingRows[0];

// Personal pace learning: for each walk segment, average the ratio
// actual/planned over the most recent 10 logs and scale the base time.
const logsBySegment = new Map<number, { plannedMin: number; actualMin: number }[]>();
for (const log of logRows) {
const list = logsBySegment.get(log.segmentId) ?? [];
if (list.length < 10) list.push({ plannedMin: log.plannedMin, actualMin: log.actualMin });
logsBySegment.set(log.segmentId, list);
}
// Learned pace is direction-independent: a walk segment A⇔B shares its
// logs whichever way the user walks it.
const learnedBySegment = new Map<
number,
{ learned: number | null; samples: number}
>();
for (const [segmentId, logs] of logsBySegment) {
const ratios = logs
.filter((l) => l.plannedMin > 0 && l.actualMin > 0)
.map((l) => l.actualMin / l.plannedMin);
if (ratios.length === 0) {
learnedBySegment.set(segmentId, { learned: null, samples: logs.length});
} else {
const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
learnedBySegment.set(segmentId, {
learned: Math.min(2, Math.max(0.5, avg)),
samples: ratios.length,
});
}
}

const routes: StateResponse["routes"] = routeRows.map((route) => ({
id: route.id,
name: route.name,
bufferMin: route.bufferMin,
segments: segmentRows
.filter((s) => s.routeId === route.id)
.map((s) => {
const deps = parseDepartures(s.departures);
const retDeps = parseDepartures(s.departuresReturn);
const learning = learnedBySegment.get(s.id);
const learnedWalkMin =
s.type === "walk" &&
s.baseWalkMin!= null &&
learning?.learned!= null
? Math.round(s.baseWalkMin * learning.learned * 2) / 2
: null;
return {
id: s.id,
position: s.position,
type: s.type,
fromLabel: s.fromLabel,
toLabel: s.toLabel,
station: s.station,
line: s.line,
baseWalkMin: s.baseWalkMin,
accessMin: s.accessMin,
rideMin: s.rideMin,
departuresWeekday: deps.weekday,
departuresHoliday: deps.holiday,
lat: s.lat,
lng: s.lng,
placeName: s.placeName,
placeAddress: s.placeAddress,
toPlaceName: s.toPlaceName,
toPlaceAddress: s.toPlaceAddress,
toLat: s.toLat,
toLng: s.toLng,
returnWeekday: retDeps.weekday,
returnHoliday: retDeps.holiday,
learnedWalkMin,
walkSamples: learning?.samples?? 0,
};
}),
}));

return {
activeRouteId:
setting?.activeRouteId!= null &&
routes.some((r) => r.id === setting.activeRouteId)
? setting.activeRouteId
: (routes[0]?.id?? null),
direction: setting?.direction?? null,
directionSource: setting?.directionSource?? null,
routes,
lineStatuses: statusRows.map((row) => ({
line: row.line,
status: row.status,
delayMin: row.delayMin,
manualDelayMin: row.manualDelayMin,
summary: row.summary,
sourceUrl: row.sourceUrl,
sourceTitle: row.sourceTitle,
fetchedAt: row.fetchedAt? row.fetchedAt.toISOString(): null,
})),
walkLogs: logRows.slice(0, 50).map((log) => ({
id: log.id,
routeId: log.routeId,
segmentId: log.segmentId,
plannedMin: log.plannedMin,
actualMin: log.actualMin,
recordedAt: log.recordedAt.toISOString(),
})),
};
}

// ---------- place search helpers ----------
//
// Station / bus-stop searchability: a single free-text geocoder query is
// not enough in Japan. Nominatim alone returns foreign same-shaped names
// for 「新宿駅」, station entrances instead of the station itself, and
// traffic signals instead of bus stops （金閣寺前）. So searchPlaces fans
// out to sources that are each good at one kind of place and merges:
//   - HeartRails Express (free station database): exact railway stations
//     by partial name, with line names and coordinates.
//   - Photon (OSM autocomplete) tag-filtered to railway stations and to
//     bus stops: good partial-name matching for both.
//   - Nominatim bounded to Japan: spots, addresses, and anything else.
// Results are name-scored, deduped by name + ~100 m, and ranked with
// stations / bus stops first.

interface PlaceCandidate {
  name: string;
  address: string;
  lat: number;
  lng: number;
  kind: string;
  line: string | null;
  score: number;
}

const SEARCH_UA = "MuseTransitGuide/1.0 (personal transit artifact)";
// Japan bounding box (lon/lat): Okinawa to Hokkaido.
const JP_BBOX = "124.0,24.0,146.0,45.5";

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SEARCH_UA },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Query/name with the generic suffix stripped, for name matching. */
function coreName(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(駅|バス停|停留所)$/u, "");
}

function nameMatchScore(query: string, name: string): number {
  const q = coreName(query);
  const n = coreName(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q) || q.startsWith(n)) return 70;
  if (n.includes(q) || q.includes(n)) return 55;
  return 0;
}

function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return A.size + B.size === 0 ? 0 : (2 * hit) / (A.size + B.size);
}

/** True when a fuzzy source result plausibly refers to the queried name. */
function namePlausible(query: string, name: string): boolean {
  if (nameMatchScore(query, name) > 0) return true;
  return bigramDice(coreName(query), coreName(name)) >= 0.34;
}

function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const KIND_BASE: Record<string, number> = {
  "駅": 40,
  "バス停": 40,
  "スポット": 20,
  "地点": 10,
  "住所": 5,
};

function scoreCandidate(
  c: Omit<PlaceCandidate, "score">,
  query: string,
  sourceBonus: number,
  near: { lat: number; lng: number } | null,
): PlaceCandidate {
  let score =
    (KIND_BASE[c.kind] ?? 0) + nameMatchScore(query, c.name) + sourceBonus;
  if (near) {
    score -= Math.min(25, haversineKm(near.lat, near.lng, c.lat, c.lng) * 0.2);
  }
  return { ...c, score };
}

async function searchHeartRails(
  query: string,
  near: { lat: number; lng: number } | null,
): Promise<PlaceCandidate[]> {
  const core = coreName(query);
  if (!core) return [];
  const url =
    "https://express.heartrails.com/api/json?method=getStations&name=" +
    encodeURIComponent(core);
  const j = (await fetchJson(url)) as {
    response?: {
      station?: Array<{
        name?: string;
        prefecture?: string;
        line?: string;
        x?: number | string;
        y?: number | string;
      }>;
    };
  };
  const stations = j.response?.station ?? [];
  const groups = new Map<
    string,
    { name: string; prefecture: string; lines: string[]; lat: number; lng: number }
  >();
  for (const s of stations) {
    const lat = Number(s.y);
    const lng = Number(s.x);
    if (!s.name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${s.name}|${lat.toFixed(3)},${lng.toFixed(3)}`;
    const g = groups.get(key) ?? {
      name: s.name,
      prefecture: s.prefecture ?? "",
      lines: [],
      lat,
      lng,
    };
    if (s.line && !g.lines.includes(s.line)) g.lines.push(s.line);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) =>
    scoreCandidate(
      {
        name: g.name.endsWith("駅") ? g.name : `${g.name}駅`,
        address: [g.prefecture, g.lines.join("、")]
          .filter(Boolean)
          .join("｜"),
        lat: g.lat,
        lng: g.lng,
        kind: "駅",
        line: g.lines[0] ?? null,
      },
      query,
      15,
      near,
    ),
  );
}

interface PhotonFeature {
  properties?: {
    name?: string;
    street?: string;
    district?: string;
    city?: string;
    state?: string;
    osm_key?: string;
    osm_value?: string;
  };
  geometry?: { coordinates?: [number, number] };
}

async function searchPhoton(
  query: string,
  tags: string[],
  kind: "駅" | "バス停",
  near: { lat: number; lng: number } | null,
): Promise<PlaceCandidate[]> {
  const core = coreName(query) || query;
  const params = new URLSearchParams({
    q: core,
    limit: "10",
    bbox: JP_BBOX,
  });
  for (const t of tags) params.append("osm_tag", t);
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lng));
  }
  const j = (await fetchJson(
    `https://photon.komoot.io/api/?${params.toString()}`,
  )) as { features?: PhotonFeature[] };
  const out: PlaceCandidate[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties ?? {};
    const coords = f.geometry?.coordinates;
    if (!p.name || !coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!namePlausible(query, p.name)) continue;
    const address = [p.street, p.district, p.city, p.state]
      .filter((v, i, a) => v && a.indexOf(v) === i)
      .join(" ");
    out.push(
      scoreCandidate(
        {
          name:
            kind === "駅" && !p.name.endsWith("駅")
              ? `${p.name}駅`
              : p.name,
          address,
          lat,
          lng,
          kind,
          line: null,
        },
        query,
        5,
        near,
      ),
    );
  }
  return out;
}

interface NominatimResult {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  class?: string;
  type?: string;
}

async function searchNominatim(
  query: string,
  near: { lat: number; lng: number } | null,
  transitOnly: boolean,
): Promise<PlaceCandidate[]> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=12&addressdetails=1&accept-language=ja" +
    `&viewbox=${JP_BBOX}&bounded=1&q=` +
    encodeURIComponent(query);
  const arr = (await fetchJson(url)) as NominatimResult[];
  const out: PlaceCandidate[] = [];
  for (const r of arr) {
    const lat = Number.parseFloat(r.lat);
    const lng = Number.parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const category = r.category ?? r.class;
    const type = r.type ?? "";
    // A traffic signal named like the stop is never the place itself.
    if (category === "highway" && type === "traffic_signals") continue;
    // Station entrances/exits are noise next to the station itself.
    if (type === "subway_entrance") continue;
    const rawName = r.name?.trim() ? r.name : (r.display_name.split(",")[0] ?? "");
    let kind: string;
    let name = rawName;
    if (
      (category === "railway" &&
        (type === "station" || type === "tram_stop" || type === "halt")) ||
      (category === "public_transport" && type === "station") ||
      (category === "building" && type === "train_station")
    ) {
      kind = "駅";
      if (name && !name.endsWith("駅")) name = `${name}駅`;
    } else if (
      (category === "highway" && type === "bus_stop") ||
      category === "public_transport"
    ) {
      kind = "バス停";
    } else if (category === "tourism" || category === "amenity") {
      kind = "スポット";
    } else if (
      category === "highway" ||
      category === "building" ||
      category === "place"
    ) {
      kind = "住所";
    } else {
      kind = "地点";
    }
    if (transitOnly && kind !== "駅" && kind !== "バス停") continue;
    // Fuzzy hits from a general geocoder are often a different place
    // with a vaguely similar name; named places must plausibly match
    // the query. Address results are exempt: there the query IS the
    // address, not the result's name.
    if (kind !== "住所" && rawName && !namePlausible(query, rawName)) {
      continue;
    }
    out.push(
      scoreCandidate(
        { name, address: r.display_name, lat, lng, kind, line: null },
        query,
        0,
        near,
      ),
    );
  }
  return out;
}

async function searchGsi(
  query: string,
  near: { lat: number; lng: number } | null,
): Promise<PlaceCandidate[]> {
  // The GSI (Geospatial Information Authority of Japan) address search
  // resolves Japanese addresses down to the 番地 level, which OSM-based
  // geocoders mostly cannot.
  const url =
    "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" +
    encodeURIComponent(query);
  const arr = (await fetchJson(url)) as Array<{
    properties?: { title?: string };
    geometry?: { coordinates?: [number, number] };
  }>;
  const addressLike = /(都|道|府|県|市|区|町|村|丁目|番地|\d)/u.test(query);
  const core = coreName(query);
  const out: PlaceCandidate[] = [];
  for (const r of arr.slice(0, 5)) {
    const title = r.properties?.title;
    const coords = r.geometry?.coordinates;
    if (!title || !coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // For non-address queries, only keep addresses that actually
    // contain the queried name (e.g. 金閣寺 → …金閣寺町…).
    if (!addressLike && (!core || !coreName(title).includes(core))) continue;
    out.push(
      scoreCandidate(
        { name: title, address: title, lat, lng, kind: "住所", line: null },
        query,
        8,
        near,
      ),
    );
  }
  return out;
}

const okResponse = z.object({ ok: z.literal(true)});
type OkResponse = z.infer<typeof okResponse>;

// ---------- actions ----------

export const Actions = {
getState: defineAction({
description:
"Returns all routes with segments and learned walking times, the active route id, cached line-delay statuses, and recent walk logs.",
request: z.object({}),
response: stateResponse,
async handler(ctx): Promise<StateResponse> {
return loadState(ctx);
},
}),

saveRoute: defineAction({
description:
"Creates a route or replaces an existing route's name, buffer, and full segment list.",
request: z.object({
id: z.number().nullable(),
name: z.string().min(1).max(80),
bufferMin: z.number().int().min(0).max(30),
segments: z.array(segmentInput).min(1).max(30),
}),
response: z.object({ id: z.number()}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
let routeId = args.id;
if (routeId == null) {
const inserted = await db
.insert(schema.routes)
.values({ name: args.name, bufferMin: args.bufferMin})
.returning({ id: schema.routes.id});
const row = inserted[0];
if (!row) throw new Error("saveRoute: insert returned no rows");
routeId = row.id;
} else {
await db
.update(schema.routes)
.set({ name: args.name, bufferMin: args.bufferMin})
.where(eq(schema.routes.id, routeId));
await db
.delete(schema.segments)
.where(eq(schema.segments.routeId, routeId));
}
for (const [i, seg] of args.segments.entries()) {
await db.insert(schema.segments).values({
routeId,
position: i,
type: seg.type,
fromLabel: seg.fromLabel,
toLabel: seg.toLabel,
station: seg.station,
line: seg.line,
baseWalkMin: seg.baseWalkMin,
accessMin: seg.accessMin,
rideMin: seg.rideMin,
departures: seg.departures? JSON.stringify(seg.departures): null,
lat: seg.lat,
lng: seg.lng,
placeName: seg.placeName,
placeAddress: seg.placeAddress,
toPlaceName: seg.toPlaceName,
toPlaceAddress: seg.toPlaceAddress,
toLat: seg.toLat,
toLng: seg.toLng,
departuresReturn: seg.departuresReturn
? JSON.stringify(seg.departuresReturn)
: null,
});
}
ctx.invalidateQueries();
return { id: routeId};
},
}),

deleteRoute: defineAction({
description: "Deletes a route together with its segments and walk logs.",
request: z.object({ id: z.number()}),
response: okResponse,
async handler(ctx, args): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
await db
.delete(schema.segments)
.where(eq(schema.segments.routeId, args.id));
await db
.delete(schema.walkLogs)
.where(eq(schema.walkLogs.routeId, args.id));
await db.delete(schema.routes).where(eq(schema.routes.id, args.id));
const setting = (
await db
.select()
.from(schema.appSettings)
.where(eq(schema.appSettings.id, 1))
)[0];
if (setting?.activeRouteId === args.id) {
await db
.update(schema.appSettings)
.set({ activeRouteId: null, direction: null, directionSource: null })
.where(eq(schema.appSettings.id, 1));
}
ctx.invalidateQueries();
return { ok: true};
},
}),

setActiveRoute: defineAction({
description: "Marks one registered route as the active route shown on the departure board.",
request: z.object({ id: z.number()}),
response: okResponse,
async handler(ctx, args): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
const existing = (
await db
.select()
.from(schema.appSettings)
.where(eq(schema.appSettings.id, 1))
)[0];
if (existing) {
await db
.update(schema.appSettings)
.set({
activeRouteId: args.id,
direction: null,
directionSource: null,
})
.where(eq(schema.appSettings.id, 1));
} else {
await db
.insert(schema.appSettings)
.values({ id: 1, activeRouteId: args.id});
}
ctx.invalidateQueries();
return { ok: true};
},
}),

setDirection: defineAction({
description:
"Stores the detected (or user-corrected) travel direction on the active bidirectional route. Source 'gps' is auto-detection; 'manual' is the user's correction and sticks.",
request: z.object({
direction: z.enum(["outbound", "return"]),
source: z.enum(["gps", "manual"]),
}),
response: okResponse,
async handler(ctx, args): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
const existing = (
await db
.select()
.from(schema.appSettings)
.where(eq(schema.appSettings.id, 1))
)[0];
if (existing) {
await db
.update(schema.appSettings)
.set({ direction: args.direction, directionSource: args.source })
.where(eq(schema.appSettings.id, 1));
} else {
await db.insert(schema.appSettings).values({
id: 1,
direction: args.direction,
directionSource: args.source,
});
}
ctx.invalidateQueries();
return { ok: true};
},
}),

clearDirection: defineAction({
description:
"Clears the stored travel direction (including a manual correction) so GPS auto-detection takes over again on the next position fix.",
request: z.object({}),
response: okResponse,
async handler(ctx): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
const existing = (
await db
.select()
.from(schema.appSettings)
.where(eq(schema.appSettings.id, 1))
)[0];
if (existing) {
await db
.update(schema.appSettings)
.set({ direction: null, directionSource: null })
.where(eq(schema.appSettings.id, 1));
}
ctx.invalidateQueries();
return { ok: true};
},
}),

searchPlaces: defineAction({
description:
"Searches places by spot name or address so a point on a route can be registered without typing coordinates. Railway stations come from the HeartRails station database (with line names), stations and bus stops also from tag-filtered OpenStreetMap/Photon, and spots/addresses from Nominatim bounded to Japan; results are merged, deduped, and ranked with stations and bus stops first. Optional nearLat/nearLng bias ranking toward a known nearby point (e.g. the previous spot on the route).",
request: z.object({
query: z.string().min(1).max(120),
nearLat: z.number().min(-90).max(90).nullable().optional(),
nearLng: z.number().min(-180).max(180).nullable().optional(),
}),
response: z.object({
places: z.array(
z.object({
name: z.string(),
address: z.string(),
lat: z.number(),
lng: z.number(),
kind: z.string(),
line: z.string().nullable(),
}),
),
}),
async handler(_ctx, args) {
const query = args.query.trim();
const near =
args.nearLat != null && args.nearLng != null
? { lat: args.nearLat, lng: args.nearLng }
: null;
const settled = await Promise.allSettled([
searchHeartRails(query, near),
searchPhoton(
query,
["railway:station", "railway:tram_stop", "building:train_station"],
"駅",
near,
),
searchPhoton(query, ["highway:bus_stop"], "バス停", near),
searchNominatim(query, near, false),
searchGsi(query, near),
]);
let all: PlaceCandidate[] = [];
for (const s of settled) {
if (s.status === "fulfilled") all = all.concat(s.value);
}
// Bus stops are the weakest-covered kind: if none surfaced and the
// query did not already say バス停, retry Nominatim with the word
// appended — its tokenizer only then restricts to bus_stop features.
if (
!all.some((c) => c.kind === "バス停") &&
!query.includes("バス停")
) {
try {
const extra = await searchNominatim(`${query} バス停`, near, true);
all = all.concat(extra);
} catch {
// keep what we have
}
}
const byKey = new Map<string, PlaceCandidate>();
for (const c of all) {
const key = `${c.name}|${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
const prev = byKey.get(key);
if (!prev) {
byKey.set(key, c);
} else {
byKey.set(key, {
...(c.score > prev.score ? c : prev),
line: prev.line ?? c.line,
});
}
}
const places = [...byKey.values()]
.sort((a, b) => b.score - a.score)
.slice(0, 10)
.map((c) => ({
name: c.name,
address: c.address,
lat: c.lat,
lng: c.lng,
kind: c.kind,
line: c.line,
}));
return { places };
},
}),

reverseGeocode: defineAction({
description:
"Looks up the nearest named place/address for map-picked coordinates (OpenStreetMap/Nominatim reverse geocoding), so a point dropped on the map gets a human-readable name.",
request: z.object({
lat: z.number().min(-90).max(90),
lng: z.number().min(-180).max(180),
}),
response: z.object({
name: z.string().nullable(),
address: z.string().nullable(),
}),
async handler(_ctx, args) {
try {
const url =
`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ja&lat=${args.lat}&lon=${args.lng}`;
const res = await fetch(url, {
headers: {
"User-Agent": "MuseTransitGuide/1.0 (personal transit artifact)",
},
});
if (!res.ok) return { name: null, address: null};
const j = (await res.json()) as {
name?: string;
display_name?: string;
address?: Record<string, string>;
};
const addr = j.address?? {};
const fallbackName =
addr.railway ??
addr.tourism ??
addr.amenity ??
addr.building ??
addr.road ??
addr.neighbourhood ??
addr.suburb ??
"";
return {
name: j.name?.trim() ? j.name : fallbackName || null,
address: j.display_name?? null,
};
} catch {
return { name: null, address: null};
}
},
}),

recordWalk: defineAction({
description:
"Records an actual walking time for a walk segment so the app learns the user's personal pace for future predictions.",
request: z.object({
segmentId: z.number(),
plannedMin: z.number().min(0.1).max(600),
actualMin: z.number().min(0.1).max(600),
}),
response: okResponse,
async handler(ctx, args): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
const seg = (
await db
.select()
.from(schema.segments)
.where(eq(schema.segments.id, args.segmentId))
)[0];
if (!seg) throw new Error("recordWalk: segment not found");
await db.insert(schema.walkLogs).values({
routeId: seg.routeId,
segmentId: seg.id,
plannedMin: args.plannedMin,
actualMin: args.actualMin,
});
ctx.invalidateQueries();
return { ok: true};
},
}),

deleteWalkLog: defineAction({
description: "Deletes one walk log entry (used to undo a mistaken pace record).",
request: z.object({ id: z.number()}),
response: okResponse,
async handler(ctx, args): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
await db
.delete(schema.walkLogs)
.where(eq(schema.walkLogs.id, args.id));
ctx.invalidateQueries();
return { ok: true};
},
}),

setManualDelay: defineAction({
description:
"Sets or clears a manual delay-minutes override for a line; the override takes precedence over fetched delay info in predictions.",
request: z.object({
line: z.string().min(1).max(80),
delayMin: z.number().int().min(0).max(300).nullable(),
}),
response: okResponse,
async handler(ctx, args): Promise<OkResponse> {
const db = ctx.db<typeof schema>();
const existing = (
await db
.select()
.from(schema.lineStatus)
.where(eq(schema.lineStatus.line, args.line))
)[0];
if (existing) {
await db
.update(schema.lineStatus)
.set({ manualDelayMin: args.delayMin})
.where(eq(schema.lineStatus.line, args.line));
} else {
await db.insert(schema.lineStatus).values({
line: args.line,
status: "unknown",
manualDelayMin: args.delayMin,
});
}
ctx.invalidateQueries();
return { ok: true};
},
}),

refreshLineStatus: defineAction({
description:
"Fetches the current operating status and delay minutes for one line from official operator pages via web search, classifies it, and caches it with its source.",
request: z.object({ line: z.string().min(1).max(80)}),
response: z.object({
ok: z.boolean(),
message: z.string().nullable(),
status: lineStatusShape.nullable(),
}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const fail = async (message: string) => {
const cached = (
await db
.select()
.from(schema.lineStatus)
.where(eq(schema.lineStatus.line, args.line))
)[0];
return {
ok: false,
message,
status: cached
? {
line: cached.line,
status: cached.status,
delayMin: cached.delayMin,
manualDelayMin: cached.manualDelayMin,
summary: cached.summary,
sourceUrl: cached.sourceUrl,
sourceTitle: cached.sourceTitle,
fetchedAt: cached.fetchedAt
? cached.fetchedAt.toISOString()
: null,
}
: null,
};
};

let searchText = "";
let topUrl: string | null = null;
let topTitle: string | null = null;
try {
const res = await ctx.tool.web_search(
`${args.line} 運行情報 遅延 現在`,
);
const results = res.content.results?? [];
const official =
results.find((r) =>
/(jreast\.co\.jp|jreast|tokyometro|seibu|keio|odakyu|tobu|keisei|keikyu|sotetsu|metro|jr|railway|traininfo)/i.test(
r.source?? "",
),
)?? results[0];
if (!official) return fail("運行情報が見つかりませんでした");
topUrl = official.url?? null;
topTitle = official.title?? null;
searchText = results
.slice(0, 4)
.map(
(r) => `(${r.source?? ""})\n${r.snippet?? ""}`,
)
.join("\n\n");
} catch {
return fail("運行情報の検索に失敗しました");
}
if (!searchText.trim()) return fail("運行情報が見つかりませんでした");

const judgmentSchema = z.object({
status: z.enum(["normal", "delayed", "suspended", "unknown"]),
delayMin: z
.number()
.int()
.min(0)
.max(300)
.nullable()
.describe(
"現在の最大遅延分数。平常運転なら0、遅延分数が読み取れない場合はnull",
),
summary: z
.string()
.max(160)
.describe("運行状況の要約（日本語、1文）"),
});
let judged: z.infer<typeof judgmentSchema>;
try {
judged = await ctx.inference.complete(
`次は鉄道の運行情報ページの検索結果です。対象路線「${args.line}」の「現在」の運行状況を判定してください。過去の履歴（遅延証明書の過去分など）は無視し、現在の状況だけを見てください。平常運転であれば status は normal、delayMin は 0 です。遅れている場合はおおよその最大遅延分数を delayMin に入れてください。情報が古い・対象路線のものか判別できない場合は unknown にしてください。\n\n${searchText}`,
{ schema: judgmentSchema},
);
} catch {
return fail("運行情報の解析に失敗しました");
}

const now = new Date();
const existing = (
await db
.select()
.from(schema.lineStatus)
.where(eq(schema.lineStatus.line, args.line))
)[0];
const values = {
status: judged.status,
delayMin:
judged.status === "normal"? 0: judged.delayMin,
summary: judged.summary,
sourceUrl: topUrl,
sourceTitle: topTitle,
fetchedAt: now,
};
if (existing) {
await db
.update(schema.lineStatus)
.set(values)
.where(eq(schema.lineStatus.line, args.line));
} else {
await db
.insert(schema.lineStatus)
.values({ line: args.line,...values});
}
ctx.invalidateQueries();
const saved = (
await db
.select()
.from(schema.lineStatus)
.where(eq(schema.lineStatus.line, args.line))
)[0];
return {
ok: true,
message: null,
status: saved
? {
line: saved.line,
status: saved.status,
delayMin: saved.delayMin,
manualDelayMin: saved.manualDelayMin,
summary: saved.summary,
sourceUrl: saved.sourceUrl,
sourceTitle: saved.sourceTitle,
fetchedAt: saved.fetchedAt
? saved.fetchedAt.toISOString()
: null,
}
: null,
};
},
}),
} satisfies ActionsModule;
