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
"Searches places by spot name or address (OpenStreetMap/Nominatim) so a point on a route can be registered without typing coordinates. Returns display name, address, and internal coordinates for each candidate.",
request: z.object({ query: z.string().min(1).max(120)}),
response: z.object({
places: z.array(
z.object({
name: z.string(),
address: z.string(),
lat: z.number(),
lng: z.number(),
kind: z.string(),
}),
),
}),
async handler(_ctx, args) {
const empty = { places: [] as {
name: string;
address: string;
lat: number;
lng: number;
kind: string;
}[]};
try {
const url =
"https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&accept-language=ja&q=" +
encodeURIComponent(args.query);
const res = await fetch(url, {
headers: {
"User-Agent": "MuseTransitGuide/1.0 (personal transit artifact)",
},
});
if (!res.ok) return empty;
const arr = (await res.json()) as Array<{
lat: string;
lon: string;
name?: string;
display_name: string;
category?: string;
class?: string;
type?: string;
}>;
const seen = new Set<string>();
const places: typeof empty.places = [];
for (const r of arr) {
const lat = Number.parseFloat(r.lat);
const lng = Number.parseFloat(r.lon);
if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
if (seen.has(key)) continue;
seen.add(key);
const category = r.category?? r.class;
const kind =
category === "railway" && r.type === "station"
? "駅"
: category === "tourism" || category === "amenity"
? "スポット"
: category === "highway" || category === "building" || category === "place"
? "住所"
: "地点";
places.push({
name: r.name?.trim() ? r.name : r.display_name.split(",")[0] ?? "",
address: r.display_name,
lat,
lng,
kind,
});
}
return { places};
} catch {
return empty;
}
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
