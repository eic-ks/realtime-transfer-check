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
import type { BatchItem } from "drizzle-orm/batch";
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

const timetableShape = z.object({
line: z.string(),
station: z.string(),
toward: z.string(),
weekday: z.array(z.number()),
holiday: z.array(z.number()),
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
timetables: z.array(timetableShape),
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

function parseMinuteList(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (n): n is number => typeof n === "number" && n >= 0 && n < 1560,
        )
      : [];
  } catch {
    return [];
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
const timetableRows = await db.select().from(schema.timetableCache);
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
timetables: timetableRows.map((row) => ({
line: row.line,
station: row.station,
toward: row.toward,
weekday: parseMinuteList(row.weekday),
holiday: parseMinuteList(row.holiday),
sourceUrl: row.sourceUrl,
sourceTitle: row.sourceTitle,
fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
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

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (
    n < a.length &&
    n < b.length &&
    a[a.length - 1 - n] === b[b.length - 1 - n]
  ) {
    n++;
  }
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** True when a fuzzy source result plausibly refers to the queried name. */
function namePlausible(query: string, name: string): boolean {
  if (nameMatchScore(query, name) > 0) return true;
  const q = coreName(query);
  const n = coreName(name);
  // Renamed-station shape: 阪急梅田 vs 大阪梅田 — the operator/city
  // prefix differs but the distinctive tail (梅田) is shared, with at
  // most a short prefix left over on each side. The bigram Dice for
  // that pair is 0.333, just under the fuzzy threshold, which used to
  // filter the real station out and leave only the same-named bus
  // stop. A shared tail of ≥2 chars with ≤2 leftover chars per side
  // is specific enough for tag-filtered station/bus-stop sources —
  // but only when the heads differ entirely: 金閣寺前 vs 金昌寺前
  // share the head 金 AND the tail 寺前 yet are different stops, so a
  // common prefix disqualifies the pair.
  const suffix = commonSuffixLen(q, n);
  if (
    suffix >= 2 &&
    q.length - suffix <= 2 &&
    n.length - suffix <= 2 &&
    commonPrefixLen(q, n) === 0
  ) {
    return true;
  }
  return bigramDice(q, n) >= 0.34;
}

// Stations renamed in recent years are still widely known — and
// searched — by their old operator-prefixed names, while every
// station database (HeartRails, OSM) only carries the current
// official name. Without this bridge, 「阪急梅田駅」 finds no station
// at all (HeartRails answers "not found" for 阪急梅田; the station is
// 大阪梅田 since the 2019 rename) and only the same-named bus stop
// surfaces. Keys and values are name cores (駅 suffix stripped);
// every entry was verified live against HeartRails (old name →
// error or wrong region, current name → the intended station).
const STATION_NAME_ALIASES: Record<string, string[]> = {
  "阪急梅田": ["大阪梅田"],
  "阪神梅田": ["大阪梅田"],
  "近鉄難波": ["大阪難波"],
  "阪神難波": ["大阪難波"],
  "河原町": ["京都河原町"],
  "三宮": ["神戸三宮"],
};

/** The name itself plus its current official name(s), as cores. */
function stationNameVariants(name: string): string[] {
  const core = coreName(name);
  if (!core) return [];
  const out = [core];
  for (const alias of STATION_NAME_ALIASES[core] ?? []) {
    if (alias && !out.includes(alias)) out.push(alias);
  }
  return out;
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
  // Every name variant is queried: for a renamed station the old name
  // errors out ("not found") and only the current official name hits.
  // Candidates are scored against the variant that produced them, so
  // an alias hit ranks as the exact match it is.
  const out: PlaceCandidate[] = [];
  for (const core of stationNameVariants(query)) {
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
    for (const g of groups.values()) {
      out.push(
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
          core,
          15,
          near,
        ),
      );
    }
  }
  return out;
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

// ---------- line diagram + automatic timetable helpers ----------

/** Ordered stations of one line from the HeartRails station database. */
async function heartRailsLineStations(
  line: string,
): Promise<
  { name: string; lat: number; lng: number; prefecture: string }[]
> {
  const url =
    "https://express.heartrails.com/api/json?method=getStations&line=" +
    encodeURIComponent(line.trim());
  const j = (await fetchJson(url)) as {
    response?: {
      station?: Array<{
        name?: string;
        prefecture?: string;
        x?: number | string;
        y?: number | string;
        prev?: string | null;
        next?: string | null;
      }>;
      error?: string;
    };
  };
  const raw = j.response?.station ?? [];
  type Raw = NonNullable<typeof raw>[number];
  const byName = new Map<string, Raw>();
  for (const s of raw) if (s.name) byName.set(s.name, s);
  // Rebuild travel order from the prev/next chain (the chain is the
  // authoritative diagram; the raw API order is only a fallback).
  const start = raw.find((s) => !s.prev || !byName.has(s.prev));
  const ordered: Raw[] = [];
  const seen = new Set<string>();
  let cur: Raw | undefined = start ?? raw[0];
  while (cur && cur.name && !seen.has(cur.name)) {
    seen.add(cur.name);
    ordered.push(cur);
    cur = cur.next ? byName.get(cur.next) : undefined;
  }
  for (const s of raw) if (s.name && !seen.has(s.name)) ordered.push(s);
  return ordered
    .map((s) => ({
      name: s.name ?? "",
      lat: Number(s.y),
      lng: Number(s.x),
      prefecture: s.prefecture ?? "",
    }))
    .filter(
      (s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng),
    );
}

// Automatic timetables come from 駅探 (ekitan) station timetable
// pages, which are fully server-rendered: a station page lists, per
// line, one link per direction ("○○方面"), and each direction page
// contains the whole day's departures as plain text. A dt=YYYYMMDD
// query picks the service day, so a Tuesday renders the weekday
// timetable and a Saturday the holiday one. Extraction is
// deterministic (no model inference): strip the HTML and collect the
// HH:MM entries listed under すべての時刻. (NAVITIME, the other big
// timetable site, answers 403 to server fetches, and ジョルダン is
// JavaScript-rendered, so neither works as a fetch source.)

const EKITAN_BASE = "https://ekitan.com";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

async function fetchPageText(
  url: string,
  timeoutMs = 20000,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "ja,en;q=0.8",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

interface EkitanDirection {
  url: string;
  label: string;
}
interface EkitanLineBlock {
  line: string;
  directions: EkitanDirection[];
}

/** Per-line direction links of an ekitan station page. */
function parseEkitanStationPage(html: string): EkitanLineBlock[] {
  const titles: { idx: number; line: string }[] = [];
  const titleRe =
    /<p class="link-title"><a href="\/timetable\/railway\/line\/\d+"[^>]*>([^<]+)<\/a><\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    const line = m[1];
    if (line) titles.push({ idx: m.index, line: line.trim() });
  }
  const blocks: EkitanLineBlock[] = titles.map((t) => ({
    line: t.line,
    directions: [],
  }));
  const dirRe =
    /href="(\/timetable\/railway\/line-station\/[0-9-]+\/d\d)"[^>]*>\s*<span class="text"[^>]*>([^<]+)<\/span>/g;
  while ((m = dirRe.exec(html)) !== null) {
    const href = m[1];
    const label = m[2];
    if (!href || !label) continue;
    // Owning line block = the last line title before this anchor.
    let owner: EkitanLineBlock | undefined;
    for (let i = 0; i < titles.length; i++) {
      if ((titles[i]?.idx ?? Infinity) < m.index) owner = blocks[i];
    }
    owner?.directions.push({
      url: EKITAN_BASE + href,
      label: label.trim(),
    });
  }
  return blocks.filter((b) => b.directions.length > 0);
}

/** Line-name match tolerant of a leading "JR" and spacing. */
function lineNameMatch(want: string, got: string): boolean {
  const norm = (s: string) =>
    s.replace(/\s+/g, "").replace(/^JR/u, "").replace(/線$/u, "");
  const w = norm(want);
  const g = norm(got);
  if (!w || !g) return false;
  if (w === g || g.includes(w) || w.includes(g)) return true;
  // Operator branding: ekitan names subway lines WITH the operator
  // (大阪メトロ御堂筋線) while the station DB (HeartRails) drops it
  // (大阪御堂筋線), so the plain substring checks fail on the infix
  // メトロ. Compare once more with operator/city words removed from
  // both sides (exact equality on the stripped core, min length 2,
  // so distinct lines like 谷町線 vs 中央線 never collide).
  const bare = (s: string) =>
    norm(s)
      .replace(/^(?:大阪メトロ|東京メトロ|都営|市営|営団)/u, "")
      .replace(/(?:メトロ|地下鉄|市営|都営)/gu, "")
      .replace(/^(?:大阪|東京|名古屋|京都|神戸|福岡|札幌|仙台|横浜)/u, "");
  const bw = bare(want);
  const bg = bare(got);
  return bw.length >= 2 && bw === bg;
}

/**
 * True when two station name cores plausibly name the same station:
 * exact, or one is the other with a city/operator prefix difference
 * (梅田 vs 大阪梅田, 難波 vs 大阪難波). Used when matching a stored
 * station name against a line diagram or an ekitan station list,
 * where the same physical station is named per-operator.
 */
function stationCoreLooseEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && (long as string).endsWith(short as string);
}

/**
 * Choose the direction link that travels from the boarding station
 * toward the alighting station. Primary signal: the line's station
 * order (HeartRails) — a direction label names stations on one side,
 * and the right side is the one containing the alighting station and
 * everything beyond it. Fallbacks: the label naming the alighting
 * station itself, then an actual train page whose stop list runs
 * boarding → alighting.
 */
async function pickEkitanDirection(
  dirs: EkitanDirection[],
  line: string,
  boardingCore: string,
  alightingCore: string,
): Promise<EkitanDirection | null> {
  const only = dirs[0];
  if (dirs.length === 1) return only ?? null;
  if (dirs.length === 0) return null;

  const labelTokens = (label: string): string[] =>
    label
      .replace(/方面$/u, "")
      .split(/[・、/／]/u)
      .map((t) => coreName(t.replace(/\(.*?\)|（.*?）/gu, "").trim()))
      .filter(Boolean);

  // A renamed station (阪急梅田) is on the line diagram only under
  // its current name (大阪梅田), so both ends match by any variant.
  // The match is also prefix-tolerant (stationCoreLooseEq): the same
  // physical station is 梅田 on the Metro diagram but 大阪梅田 on
  // Hankyu's, and the stored alighting name follows whichever
  // operator the user picked it from.
  const boardingCores = stationNameVariants(boardingCore);
  const alightingCores = stationNameVariants(alightingCore);
  try {
    const stations = await heartRailsLineStations(line);
    const cores = stations.map((s) => coreName(s.name));
    const bi = cores.findIndex((c) =>
      boardingCores.some((v) => stationCoreLooseEq(c, v)),
    );
    const ai = cores.findIndex((c) =>
      alightingCores.some((v) => stationCoreLooseEq(c, v)),
    );
    if (bi >= 0 && ai >= 0 && bi !== ai) {
      const side = new Set(
        ai > bi ? cores.slice(bi + 1) : cores.slice(0, bi).reverse(),
      );
      for (const d of dirs) {
        if (labelTokens(d.label).some((t) => side.has(t))) return d;
      }
    }
  } catch {
    // fall through to the label / train-page checks
  }

  for (const d of dirs) {
    if (
      labelTokens(d.label).some((t) =>
        alightingCores.some((v) => stationCoreLooseEq(t, v)),
      )
    ) {
      return d;
    }
  }

  // Last resort: open each direction's first train and see which one
  // actually stops at the alighting station after the boarding one.
  // Comparing first occurrences in the whole page text does NOT work:
  // the train page header names the boarding station before the stop
  // list starts, so a wrong-direction train whose route passes the
  // alighting station BEFORE the boarding one still "matches".
  // Compare positions inside the extracted stop sequence instead
  // (entries are "HH:MM発 <station>" / terminus "HH:MM着 <station>").
  const stopSequence = (text: string): string[] => {
    const hits: { idx: number; name: string }[] = [];
    const push = (re: RegExp) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = coreName(
          (m[1] ?? "").replace(/\(.*?\)|（.*?）/gu, ""),
        );
        if (name) hits.push({ idx: m.index, name });
      }
    };
    push(/\d{1,2}:\d{2}発\s+([^\s－]+)/g);
    push(/\d{1,2}:\d{2}着\s+([^\s－\d][^\s－]*)/g);
    return hits.sort((a, b) => a.idx - b.idx).map((h) => h.name);
  };
  for (const d of dirs) {
    const page = await fetchPageText(d.url);
    if (!page) continue;
    // The direction page embeds BOTH directions' blocks; the first
    // train link in raw HTML order belongs to direction 1's block
    // regardless of which direction this page shows, so look inside
    // this direction's own block only.
    const dNumRaw = /\/d(\d)$/.exec(d.url)?.[1];
    const block = ekitanDirectionSlice(
      page,
      dNumRaw != null ? Number(dNumRaw) : undefined,
    );
    const trainHref =
      /href="(\/timetable\/railway\/train\?[^"]+)"/.exec(block)?.[1];
    if (!trainHref) continue;
    const trainHtml = await fetchPageText(EKITAN_BASE + trainHref);
    if (!trainHtml) continue;
    const seq = stopSequence(htmlToText(trainHtml));
    const bPos = seq.findIndex((n) =>
      boardingCores.some((v) => stationCoreLooseEq(n, v)),
    );
    const aPos = seq.findIndex((n) =>
      alightingCores.some((v) => stationCoreLooseEq(n, v)),
    );
    if (bPos >= 0 && aPos > bPos) return d;
  }
  return only ?? null;
}

/**
 * Slice one direction's timetable block out of an ekitan page (see
 * parseEkitanTimes for why both blocks are always present). Picks
 * the block whose data-direction matches dirNum, else the block
 * without the `hidden` class (the one the page itself displays),
 * else the first block. Returns the whole HTML when the page has no
 * direction blocks (terminus stations, older layouts).
 */
function ekitanDirectionSlice(html: string, dirNum?: number): string {
  const blockRe =
    /<div class="search-result-body[^>]*?data-direction="(\d)"/g;
  const starts: { idx: number; num: number; hidden: boolean }[] = [];
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) !== null) {
    const tagEnd = html.indexOf(">", bm.index);
    const tag = tagEnd >= 0 ? html.slice(bm.index, tagEnd + 1) : "";
    starts.push({
      idx: bm.index,
      num: Number(bm[1]),
      hidden: /\bhidden\b/.test(tag),
    });
  }
  if (starts.length === 0) return html;
  const chosen =
    (dirNum != null ? starts.find((s) => s.num === dirNum) : undefined) ??
    starts.find((s) => !s.hidden) ??
    starts[0];
  if (!chosen) return html;
  const next = starts.find((s) => s.idx > chosen.idx);
  return html.slice(chosen.idx, next ? next.idx : undefined);
}

/**
 * Departure minutes-of-day from an ekitan direction page.
 *
 * Each direction's timetable lives in its own
 * `<div class="search-result-body ..." data-direction="N">` block and
 * BOTH blocks are present in the page HTML (the unselected one just
 * carries a `hidden` class) — on d1 and d2 pages alike, in the same
 * order. Slicing the whole page text therefore merges the two
 * directions' departures into one list (verified live: なんば
 * 御堂筋線 d1 page parsed to 561 times instead of 316 northbound +
 * 313 southbound; 三日市町 merged 167 instead of 100). Terminus
 * stations have a single block, which is why earlier spot checks
 * passed. Isolate the requested direction's block in the raw HTML
 * before stripping tags: by data-direction number (from the /dN URL),
 * else the block without `hidden`, else the first block.
 */
function parseEkitanTimes(html: string, dirNum?: number): number[] {
  const slice = ekitanDirectionSlice(html, dirNum);
  const text = htmlToText(slice);
  const anchor = text.indexOf("すべての時刻");
  let seg = anchor >= 0 ? text.slice(anchor) : text;
  // Belt and braces: never read past a second timetable block.
  const second = seg.indexOf("すべての時刻", 1);
  if (second > 0) seg = seg.slice(0, second);
  const out = new Set<number>();
  const re = /(\d{1,2}):(\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (min >= 60) continue;
    const t = h * 60 + min;
    if (t >= 180 && t < 1560) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------- per-train data (type / destination / stop pattern) ----------
//
// The minutes-only parse above cannot express WHICH train departs:
// ekitan's direction page marks every departure with its train type
// and destination —
//   <li class="ek-narrow" data-tr-type="準特急" data-dest="大阪梅田">
//     <a href="/timetable/railway/train?sf=…&tx=…&departure=0605&…">
//       <span class="dep-time">06:05</span>
//       <span class="train-type …">準特急</span>
//       <span class="destination">大阪梅田行き</span>
// — and each train page lists its stopping stations as table rows
//   <td class="td-dep-and-arr-time"><span>06:09着</span><span>06:09発</span></td>
//   <td class="td-station-name"><a …>岡本(兵庫)</a></td>
// (the 着/発 suffix is authoritative; the span class names are not).
// Verified live 2026-11-10 on 阪急神戸本線 六甲 (普通/準特急/快速/急行),
// 京阪本線 出町柳 (特急/快速急行/急行/準急/普通…) and 大阪メトロ御堂筋線
// なんば (all 普通, real per-station times at 梅田). Both parsers are
// deterministic; nothing is inferred or fabricated, and a page that
// does not carry the markup yields an empty list so callers fall
// back to the minutes-only model.

interface TrainDeparture {
  depart: number;
  type: string;
  dest: string;
  href: string;
}

interface TrainStopTime {
  station: string;
  arrive: number | null;
  depart: number | null;
}

const TRAIN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Station name as used in train stop lists: core name with the
 * operator suffix in parentheses removed (岡本(兵庫) → 岡本,
 * 大阪梅田(阪急) → 大阪梅田, なんば(大阪メトロ) → なんば). */
function trainStopCore(name: string): string {
  return coreName(name.replace(/\(.*?\)|（.*?）/gu, "").trim());
}

/** Per-train departures of one direction block of an ekitan page. */
function parseEkitanTrains(html: string, dirNum?: number): TrainDeparture[] {
  const slice = ekitanDirectionSlice(html, dirNum);
  const out: TrainDeparture[] = [];
  const seen = new Set<string>();
  const liRe =
    /data-tr-type="([^"]*)"\s+data-dest="([^"]*)"[^>]*>\s*<a href="(\/timetable\/railway\/train\?[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(slice)) !== null) {
    const type = (m[1] ?? "").trim();
    const dest = (m[2] ?? "").trim();
    const href = (m[3] ?? "").replace(/&amp;/g, "&");
    if (!href) continue;
    // Departure minutes: the href's departure=HHMM parameter is the
    // machine-readable form; fall back to the dep-time span nearby.
    let depart: number | null = null;
    const depParam = /[?&]departure=(\d{2})(\d{2})/.exec(href);
    if (depParam) {
      depart = Number(depParam[1]) * 60 + Number(depParam[2]);
    } else {
      const span = /dep-time"[^>]*>(\d{1,2}):(\d{2})/.exec(
        slice.slice(m.index, m.index + 600),
      );
      if (span) depart = Number(span[1]) * 60 + Number(span[2]);
    }
    if (depart == null || depart < 0 || depart >= 1560) continue;
    const key = `${depart}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ depart, type, dest, href });
  }
  return out.sort((a, b) => a.depart - b.depart);
}

/** Stable per-train cache key: ekitan's tx= train id when present. */
function trainKeyOfHref(href: string): string {
  const tx = /[?&]tx=([^&]+)/.exec(href)?.[1];
  if (tx) return tx;
  return href.replace(/([?&])dt=\d+/, "$1").replace(/[?&]dw=[^&]*/, "");
}

/** Stop list of one train page: stopping stations in travel order. */
function parseEkitanTrainStops(html: string): TrainStopTime[] {
  const out: TrainStopTime[] = [];
  const rowRe =
    /<td class="td-dep-and-arr-time">([\s\S]*?)<\/td>\s*<td class="td-station-name"><a[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const station = trainStopCore(m[2] ?? "");
    if (!station) continue;
    let arrive: number | null = null;
    let depart: number | null = null;
    const timeRe = /(\d{1,2}):(\d{2})(発|着)/g;
    let tm: RegExpExecArray | null;
    while ((tm = timeRe.exec(m[1] ?? "")) !== null) {
      const t = Number(tm[1]) * 60 + Number(tm[2]);
      if (tm[3] === "着") arrive = t;
      else depart = t;
    }
    if (arrive == null && depart == null) continue;
    out.push({ station, arrive, depart });
  }
  return out;
}

/** Train type + destination from a train page's title block
 * ("阪急神戸本線 始発：新開地 準特急 大阪梅田(阪急)行き"). */
function parseEkitanTrainTitle(html: string): {
  type: string;
  dest: string;
} {
  const inner =
    /ek-onetrain-title-inner">([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "";
  const text = htmlToText(inner);
  const m = /始発：\S+\s+(.+?)\s+(\S+?)行き/u.exec(text);
  if (!m) return { type: "", dest: "" };
  return {
    type: (m[1] ?? "").trim(),
    dest: trainStopCore(m[2] ?? ""),
  };
}

function parseTrainListJson(raw: string | null): TrainDeparture[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is TrainDeparture =>
          typeof t === "object" &&
          t != null &&
          typeof (t as TrainDeparture).depart === "number" &&
          typeof (t as TrainDeparture).href === "string",
      )
      .map((t) => ({
        depart: t.depart,
        type: typeof t.type === "string" ? t.type : "",
        dest: typeof t.dest === "string" ? t.dest : "",
        href: t.href,
      }))
      .sort((a, b) => a.depart - b.depart);
  } catch {
    return [];
  }
}

function parseTrainStopsJson(raw: string | null): TrainStopTime[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is TrainStopTime =>
        typeof s === "object" &&
        s != null &&
        typeof (s as TrainStopTime).station === "string",
    );
  } catch {
    return [];
  }
}

/** YYYYMMDD of the next JST date (1–7 days ahead) with weekday dow
 * (0=Sunday … 6=Saturday). A Tuesday renders ekitan's weekday
 * timetable; a Saturday its holiday one. */
function nextJstDate(dow: number): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let delta = (dow - jst.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  const d = new Date(jst.getTime() + delta * 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${da}`;
}

// ---------- bus GTFS-JP via the MLIT GTFS Data Repository ----------
//
// The repository (国土交通省 GTFSデータリポジトリ, gtfs-data.jp) is the
// one no-key source that closes the bus gap: its public API v2
// (https://api.gtfs-data.jp/v2, documented at
// docs.gtfs-data.jp/api.v2.html) lists every published feed and serves
// each feed's GTFS-JP ZIP at
// /v2/organizations/<org>/feeds/<feed>/files/feed.zip?rid=current
// (302 → S3; fetch follows it). Verified live 2026-11-10: 610 feeds,
// licenses are per-feed CC BY / CC0 variants, so the operator (data
// provider) credit is carried through to the UI wherever GTFS-derived
// stops/times are shown. Kyoto's big operators （京都市交通局・京阪バス・
// 阪急バス) are NOT in the repository — their GTFS is ODPT-only and
// ODPT's API answers 403 "Require acl:consumerKey." without a token,
// so those operators stay on the honest fallback (see DATA-PLAN.md).
//
// A feed is downloaded once, parsed (agency/routes/stops/trips/
// stop_times/calendar), and materialized into gtfs_feed_cache /
// gtfs_line_cache / gtfs_departures; after that, the line diagram and
// timetables are served from the DB and the ZIP is only re-fetched
// when the cache is older than GTFS_FEED_TTL_MS. The ZIP reader is
// hand-rolled (central directory + DecompressionStream "deflate-raw",
// both verified available in this runtime); no new dependency.
// Day-type split follows the app's two-bucket model: a calendar
// service counts as 平日 when it runs Mon–Fri and 土休日 when it runs
// Sat/Sun (calendar_dates exceptions are not modeled).

const GTFS_REPO_API = "https://api.gtfs-data.jp/v2";
const GTFS_FEED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GTFS_MAX_ZIP_BYTES = 30 * 1024 * 1024;
const GTFS_MAX_STOP_TIME_ROWS = 2_000_000;
const GTFS_MAX_DEPARTURE_ROWS = 40_000;

interface GtfsStop {
  name: string;
  lat: number;
  lng: number;
}
interface GtfsRouteInfo {
  routeId: string;
  name: string;
  shortName: string;
}
interface GtfsDirectionInfo {
  routeId: string;
  routeName: string;
  directionId: number;
  toward: string;
  stops: GtfsStop[];
}
interface GtfsDepartureInfo {
  routeId: string;
  directionId: number;
  stopCore: string;
  weekday: number[];
  holiday: number[];
}
interface ParsedGtfs {
  agencyName: string;
  routes: GtfsRouteInfo[];
  directions: GtfsDirectionInfo[];
  departures: GtfsDepartureInfo[];
}
interface RepoFeedEntry {
  organization_id?: string;
  organization_name?: string;
  feed_id?: string;
  feed_name?: string;
  feed_license?: string;
  feed_license_id?: string;
  feed_page_url?: string;
}
interface GtfsFeedMeta {
  feedKey: string;
  orgId: string;
  feedId: string;
  orgName: string;
  feedName: string;
  license: string | null;
  pageUrl: string | null;
}

async function fetchBytes(
  url: string,
  timeoutMs = 60000,
): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SEARCH_UA },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal ZIP reader: central directory + stored/deflate entries. */
function unzipFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  // Entries are decompressed lazily by the caller via unzipFile().
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extra = dv.getUint16(p + 30, true);
    const comment = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const rawName = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const name = rawName.split("/").pop() ?? rawName;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtra = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtra;
    // Stash the compressed slice under a method-tagged key; the caller
    // inflates only the files it needs.
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    out.set(`${method}:${name}`, comp);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function unzipFile(
  files: Map<string, Uint8Array>,
  name: string,
): Promise<string | null> {
  const stored = files.get(`0:${name}`);
  if (stored) return new TextDecoder("utf-8").decode(stored);
  const deflated = files.get(`8:${name}`);
  if (!deflated) return null;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(deflated);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8").decode(buf);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvText(text: string): Record<string, string>[] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = t.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  const head = splitCsvLine(lines[0] ?? "");
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    head.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/** "7:05:00" / "25:10:00" → minutes of day (kept within the app's <1560 cap). */
function gtfsTimeToMin(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,3}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const t = Number(m[1]) * 60 + Number(m[2]);
  return t >= 0 && t < 1560 ? t : null;
}

async function parseGtfsFeed(
  bytes: Uint8Array,
): Promise<ParsedGtfs | null> {
  const files = unzipFiles(bytes);
  const [routesTxt, stopsTxt, tripsTxt, stopTimesTxt, calendarTxt, agencyTxt] =
    await Promise.all([
      unzipFile(files, "routes.txt"),
      unzipFile(files, "stops.txt"),
      unzipFile(files, "trips.txt"),
      unzipFile(files, "stop_times.txt"),
      unzipFile(files, "calendar.txt"),
      unzipFile(files, "agency.txt"),
    ]);
  if (!routesTxt || !stopsTxt || !tripsTxt || !stopTimesTxt) return null;

  const routes: GtfsRouteInfo[] = [];
  for (const r of parseCsvText(routesTxt)) {
    const routeId = (r.route_id ?? "").trim();
    if (!routeId) continue;
    const longName = (r.route_long_name ?? "").trim();
    const shortName = (r.route_short_name ?? "").trim();
    routes.push({
      routeId,
      name: longName || shortName || routeId,
      shortName,
    });
  }
  if (routes.length === 0) return null;
  const routeNameById = new Map(routes.map((r) => [r.routeId, r.name]));

  const stopsById = new Map<string, GtfsStop>();
  for (const s of parseCsvText(stopsTxt)) {
    const id = (s.stop_id ?? "").trim();
    const name = (s.stop_name ?? "").trim();
    const lat = Number(s.stop_lat);
    const lng = Number(s.stop_lon);
    if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    stopsById.set(id, { name, lat, lng });
  }
  if (stopsById.size === 0) return null;

  // Calendar services → the app's weekday / holiday buckets. A feed
  // without calendar.txt treats every service as running every day.
  const serviceBuckets = new Map<
    string,
    { weekday: boolean; holiday: boolean }
  >();
  if (calendarTxt) {
    for (const c of parseCsvText(calendarTxt)) {
      const on = (k: string) => c[k] === "1";
      const id = (c.service_id ?? "").trim();
      if (!id) continue;
      serviceBuckets.set(id, {
        weekday:
          on("monday") ||
          on("tuesday") ||
          on("wednesday") ||
          on("thursday") ||
          on("friday"),
        holiday: on("saturday") || on("sunday"),
      });
    }
  }
  const bucketOf = (serviceId: string) =>
    serviceBuckets.get(serviceId) ?? { weekday: true, holiday: true };

  interface TripInfo {
    routeId: string;
    directionId: number;
    serviceId: string;
  }
  const tripInfo = new Map<string, TripInfo>();
  for (const t of parseCsvText(tripsTxt)) {
    const tripId = (t.trip_id ?? "").trim();
    const routeId = (t.route_id ?? "").trim();
    if (!tripId || !routeId) continue;
    const dir = Number.parseInt(t.direction_id ?? "", 10);
    tripInfo.set(tripId, {
      routeId,
      directionId: Number.isFinite(dir) ? dir : 0,
      serviceId: (t.service_id ?? "").trim(),
    });
  }
  if (tripInfo.size === 0) return null;

  const stopTimeRows = parseCsvText(stopTimesTxt);
  if (stopTimeRows.length > GTFS_MAX_STOP_TIME_ROWS) return null;
  interface StopTime {
    stopId: string;
    seq: number;
    dep: number | null;
  }
  const timesByTrip = new Map<string, StopTime[]>();
  for (const r of stopTimeRows) {
    const tripId = (r.trip_id ?? "").trim();
    const stopId = (r.stop_id ?? "").trim();
    if (!tripId || !stopId) continue;
    const seq = Number.parseInt(r.stop_sequence ?? "", 10);
    const list = timesByTrip.get(tripId) ?? [];
    list.push({
      stopId,
      seq: Number.isFinite(seq) ? seq : list.length,
      dep: gtfsTimeToMin(r.departure_time) ?? gtfsTimeToMin(r.arrival_time),
    });
    timesByTrip.set(tripId, list);
  }

  // Line diagram per (route, direction): the trip with the most stops
  // is the representative run; its stop order is the diagram.
  const bestTrip = new Map<string, { tripId: string; count: number }>();
  for (const [tripId, times] of timesByTrip) {
    const info = tripInfo.get(tripId);
    if (!info) continue;
    const key = `${info.routeId}|${info.directionId}`;
    const cur = bestTrip.get(key);
    if (!cur || times.length > cur.count) {
      bestTrip.set(key, { tripId, count: times.length });
    }
  }
  const directions: GtfsDirectionInfo[] = [];
  for (const best of bestTrip.values()) {
    const info = tripInfo.get(best.tripId);
    if (!info) continue;
    const times = [...(timesByTrip.get(best.tripId) ?? [])].sort(
      (a, b) => a.seq - b.seq,
    );
    const stops: GtfsStop[] = [];
    for (const t of times) {
      const stop = stopsById.get(t.stopId);
      if (stop) stops.push(stop);
    }
    if (stops.length < 2) continue;
    directions.push({
      routeId: info.routeId,
      routeName: routeNameById.get(info.routeId) ?? info.routeId,
      directionId: info.directionId,
      toward: stops[stops.length - 1]?.name ?? "",
      stops,
    });
  }

  // Departures per (route, direction, stop): union over every trip
  // whose calendar service falls in the bucket.
  const depMap = new Map<
    string,
    {
      routeId: string;
      directionId: number;
      stopCore: string;
      weekday: Set<number>;
      holiday: Set<number>;
    }
  >();
  for (const [tripId, times] of timesByTrip) {
    const info = tripInfo.get(tripId);
    if (!info) continue;
    const bucket = bucketOf(info.serviceId);
    for (const t of times) {
      if (t.dep == null) continue;
      const stop = stopsById.get(t.stopId);
      if (!stop) continue;
      const stopCore = coreName(stop.name);
      if (!stopCore) continue;
      const key = `${info.routeId}|${info.directionId}|${stopCore}`;
      let entry = depMap.get(key);
      if (!entry) {
        entry = {
          routeId: info.routeId,
          directionId: info.directionId,
          stopCore,
          weekday: new Set(),
          holiday: new Set(),
        };
        depMap.set(key, entry);
      }
      if (bucket.weekday) entry.weekday.add(t.dep);
      if (bucket.holiday) entry.holiday.add(t.dep);
    }
  }
  const departures: GtfsDepartureInfo[] = [...depMap.values()].map((e) => ({
    routeId: e.routeId,
    directionId: e.directionId,
    stopCore: e.stopCore,
    weekday: [...e.weekday].sort((a, b) => a - b),
    holiday: [...e.holiday].sort((a, b) => a - b),
  }));
  if (departures.length > GTFS_MAX_DEPARTURE_ROWS) return null;

  let agencyName = "";
  if (agencyTxt) {
    const first = parseCsvText(agencyTxt)[0];
    agencyName = (first?.agency_name ?? "").trim();
  }
  return { agencyName, routes, directions, departures };
}

let repoCatalogCache: { at: number; feeds: RepoFeedEntry[] } | null = null;

async function repoCatalog(): Promise<RepoFeedEntry[]> {
  if (
    repoCatalogCache &&
    Date.now() - repoCatalogCache.at < 6 * 60 * 60 * 1000
  ) {
    return repoCatalogCache.feeds;
  }
  try {
    const j = (await fetchJson(`${GTFS_REPO_API}/feeds`, 30000)) as {
      body?: RepoFeedEntry[];
    };
    const feeds = Array.isArray(j.body) ? j.body : [];
    if (feeds.length > 0) repoCatalogCache = { at: Date.now(), feeds };
    return feeds;
  } catch {
    return repoCatalogCache?.feeds ?? [];
  }
}

async function repoFeedMeta(
  orgId: string,
  feedId: string,
): Promise<GtfsFeedMeta> {
  const feedKey = `${orgId}/${feedId}`;
  const catalog = await repoCatalog();
  const hit = catalog.find(
    (f) => f.organization_id === orgId && f.feed_id === feedId,
  );
  let orgName = hit?.organization_name ?? "";
  let feedName = hit?.feed_name ?? "";
  let license = hit?.feed_license ?? hit?.feed_license_id ?? null;
  let pageUrl = hit?.feed_page_url ?? null;
  if (!hit) {
    try {
      const j = (await fetchJson(
        `${GTFS_REPO_API}/organizations/${encodeURIComponent(orgId)}/feeds/${encodeURIComponent(feedId)}`,
        15000,
      )) as {
        body?: {
          organization_name?: string;
          feed_name?: string;
          feed_license?: string;
          feed_page_url?: string;
        };
      };
      orgName = j.body?.organization_name ?? orgName;
      feedName = j.body?.feed_name ?? feedName;
      license = j.body?.feed_license ?? license;
      pageUrl = j.body?.feed_page_url ?? pageUrl;
    } catch {
      // metadata stays partial; the feed itself can still be parsed
    }
  }
  // The repository's per-feed page (documented URL shape, also the
  // feed_page_url the API itself returns).
  if (!pageUrl) {
    pageUrl = `https://gtfs-data.jp/search?target_feed=${orgId}*${feedId}`;
  }
  return { feedKey, orgId, feedId, orgName, feedName, license, pageUrl };
}

/**
 * Download + parse + cache one repository feed (unless a fresh copy is
 * already cached). Returns the feed metadata and its route list.
 */
async function ensureGtfsFeed(
  ctx: Ctx,
  orgId: string,
  feedId: string,
): Promise<{ meta: GtfsFeedMeta; routes: GtfsRouteInfo[] } | null> {
  const db = ctx.db<typeof schema>();
  const feedKey = `${orgId}/${feedId}`;
  const cached = (
    await db
      .select()
      .from(schema.gtfsFeedCache)
      .where(eq(schema.gtfsFeedCache.feedKey, feedKey))
  )[0];
  if (
    cached?.fetchedAt &&
    cached.routes &&
    Date.now() - cached.fetchedAt.getTime() < GTFS_FEED_TTL_MS
  ) {
    try {
      const routes = JSON.parse(cached.routes) as GtfsRouteInfo[];
      if (Array.isArray(routes) && routes.length > 0) {
        return {
          meta: {
            feedKey,
            orgId,
            feedId,
            orgName: cached.orgName,
            feedName: cached.feedName,
            license: cached.licenseName,
            pageUrl: cached.pageUrl,
          },
          routes,
        };
      }
    } catch {
      // fall through and re-ingest
    }
  }

  const meta = await repoFeedMeta(orgId, feedId);
  const zip = await fetchBytes(
    `${GTFS_REPO_API}/organizations/${encodeURIComponent(orgId)}/feeds/${encodeURIComponent(feedId)}/files/feed.zip?rid=current`,
    90000,
  );
  if (!zip || zip.length > GTFS_MAX_ZIP_BYTES) return null;
  let parsed: ParsedGtfs | null = null;
  try {
    parsed = await parseGtfsFeed(zip);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.routes.length === 0) return null;

  const orgName = meta.orgName || parsed.agencyName || "";
  const now = new Date();
  const statements: BatchItem<"sqlite">[] = [
    db
      .delete(schema.gtfsLineCache)
      .where(eq(schema.gtfsLineCache.feedKey, feedKey)),
    db
      .delete(schema.gtfsDepartures)
      .where(eq(schema.gtfsDepartures.feedKey, feedKey)),
    db
      .insert(schema.gtfsFeedCache)
      .values({
        feedKey,
        orgName,
        feedName: meta.feedName,
        licenseName: meta.license,
        pageUrl: meta.pageUrl,
        routes: JSON.stringify(parsed.routes),
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.gtfsFeedCache.feedKey,
        set: {
          orgName,
          feedName: meta.feedName,
          licenseName: meta.license,
          pageUrl: meta.pageUrl,
          routes: JSON.stringify(parsed.routes),
          fetchedAt: now,
        },
      }),
  ];
  for (const d of parsed.directions) {
    statements.push(
      db.insert(schema.gtfsLineCache).values({
        cacheKey: `${feedKey}|${d.routeId}|${d.directionId}`,
        feedKey,
        routeId: d.routeId,
        routeName: d.routeName,
        directionId: d.directionId,
        toward: d.toward,
        stops: JSON.stringify(d.stops),
        fetchedAt: now,
      }),
    );
  }
  for (const dep of parsed.departures) {
    statements.push(
      db.insert(schema.gtfsDepartures).values({
        cacheKey: `${feedKey}|${dep.routeId}|${dep.directionId}|${dep.stopCore}`,
        feedKey,
        routeId: dep.routeId,
        directionId: dep.directionId,
        stopCore: dep.stopCore,
        weekday: JSON.stringify(dep.weekday),
        holiday: JSON.stringify(dep.holiday),
      }),
    );
  }
  for (let i = 0; i < statements.length; i += 100) {
    const chunk = statements.slice(i, i + 100);
    const [first, ...rest] = chunk;
    if (first) await db.batch([first, ...rest]);
  }
  return { meta: { ...meta, orgName }, routes: parsed.routes };
}

function parseGtfsStopsJson(raw: string | null): GtfsStop[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is GtfsStop =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as GtfsStop).name === "string" &&
          typeof (s as GtfsStop).lat === "number" &&
          typeof (s as GtfsStop).lng === "number",
      )
      .map((s) => ({ name: s.name, lat: s.lat, lng: s.lng }));
  } catch {
    return [];
  }
}

// ---------- actions ----------

// ---------- shared ekitan direction resolution + per-train fetch ----------

type EkitanSearchFn = (query: string) => Promise<{
  content: {
    results?: Array<{
      url?: string | null;
      title?: string | null;
      source?: string | null;
    }>;
  };
}>;

/**
 * Resolve the ekitan direction links for (line, boarding station) —
 * the same deterministic resolution fetchTimetable uses (regional
 * index → line page → station page), with the web-search backup
 * paths. Extracted so the per-train fetch shares exactly one
 * resolution implementation.
 */
async function resolveEkitanDirectionsShared(
  search: EkitanSearchFn,
  line: string,
  station: string,
): Promise<EkitanDirection[] | { error: string }> {
  const stationCore = coreName(station);
  const stationCores = stationNameVariants(station);
  const fromStationPage = async (
    stationUrl: string,
  ): Promise<EkitanDirection[] | null> => {
    const html = await fetchPageText(stationUrl);
    if (!html) return null;
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "";
    const titleOk = stationCores.some((c) => {
      if (title.includes(c)) return true;
      const short = c.replace(/^(?:大阪|東京|京都|神戸|名古屋)/u, "");
      return short.length >= 2 && title.includes(short);
    });
    if (!titleOk) return null;
    const blocks = parseEkitanStationPage(html);
    const block = blocks.find((b) => lineNameMatch(line, b.line));
    return block ? block.directions : null;
  };
  const fromLinePage = async (
    lineUrl: string,
  ): Promise<EkitanDirection[] | null> => {
    const html = await fetchPageText(lineUrl);
    if (!html) return null;
    const anchorRe =
      /href="(\/timetable\/railway\/station\/\d+)"[^>]*>([^<]+)<\/a>/g;
    let am: RegExpExecArray | null;
    while ((am = anchorRe.exec(html)) !== null) {
      const href = am[1];
      const name = (am[2] ?? "").replace(/\(.*?\)|（.*?）/gu, "");
      if (
        href &&
        stationCores.some((v) => stationCoreLooseEq(coreName(name), v))
      ) {
        return fromStationPage(EKITAN_BASE + href);
      }
    }
    return null;
  };

  const PREFECTURE_AREA: Record<string, number> = {
    "北海道": 3,
    "青森県": 4, "岩手県": 4, "宮城県": 4, "秋田県": 4, "山形県": 4, "福島県": 4,
    "茨城県": 0, "栃木県": 0, "群馬県": 0, "埼玉県": 0, "千葉県": 0, "東京都": 0, "神奈川県": 0,
    "新潟県": 6, "山梨県": 6, "長野県": 6,
    "富山県": 5, "石川県": 5, "福井県": 5,
    "岐阜県": 2, "静岡県": 2, "愛知県": 2, "三重県": 2,
    "滋賀県": 1, "京都府": 1, "大阪府": 1, "兵庫県": 1, "奈良県": 1, "和歌山県": 1,
    "鳥取県": 7, "島根県": 7, "岡山県": 7, "広島県": 7, "山口県": 7,
    "徳島県": 8, "香川県": 8, "愛媛県": 8, "高知県": 8,
    "福岡県": 9, "佐賀県": 9, "長崎県": 9, "熊本県": 9, "大分県": 9, "宮崎県": 9, "鹿児島県": 9, "沖縄県": 9,
  };
  let prefArea: number | null = null;
  try {
    const stations = await heartRailsLineStations(line);
    const boarding = stations.find((s) =>
      stationCores.some((v) => stationCoreLooseEq(coreName(s.name), v)),
    );
    if (boarding) {
      prefArea = PREFECTURE_AREA[boarding.prefecture] ?? null;
    }
  } catch {
    // region unknown -> scan all regions in order
  }
  const areaOrder = [
    ...(prefArea != null ? [prefArea] : []),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((a) => a !== prefArea),
  ];
  for (const area of areaOrder) {
    const html = await fetchPageText(
      `${EKITAN_BASE}/timetable/railway/area/${area}`,
    );
    if (!html) continue;
    const lineRe =
      /<a href="(\/timetable\/railway\/line\/\d+)"[^>]*>(?:<span[^>]*>)?([^<]+)/g;
    const matches: { url: string; exact: boolean }[] = [];
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(html)) !== null) {
      const href = lm[1];
      const name = (lm[2] ?? "").trim();
      if (!href || !name) continue;
      if (lineNameMatch(line, name)) {
        matches.push({
          url: EKITAN_BASE + href,
          exact:
            coreName(name).replace(/^JR/u, "") ===
            coreName(line).replace(/^JR/u, ""),
        });
      }
    }
    matches.sort((a, b) => Number(b.exact) - Number(a.exact));
    for (const cand of matches.slice(0, 2)) {
      const dirs = await fromLinePage(cand.url);
      if (dirs && dirs.length > 0) return dirs;
    }
    if (matches.length > 0) break;
  }

  const stationUrls: string[] = [];
  const lineUrls: string[] = [];
  const lineStationCodes: string[] = [];
  const queries = [
    `${line} ${stationCore}駅 時刻表 駅探`,
    `${stationCore}駅 時刻表 駅探`,
    `${line} ${stationCore}駅 時刻表`,
  ];
  for (const q of queries) {
    try {
      const res = await search(q);
      for (const r of res.content.results ?? []) {
        const u = r.url ?? "";
        const sm = /ekitan\.com\/timetable\/railway\/station\/(\d+)/.exec(u);
        if (sm?.[1]) {
          const url = `${EKITAN_BASE}/timetable/railway/station/${sm[1]}`;
          if (!stationUrls.includes(url)) stationUrls.push(url);
          continue;
        }
        const sf = /[?&]sf=(\d+)/.exec(u);
        if (sf?.[1] && u.includes("ekitan.com")) {
          const url = `${EKITAN_BASE}/timetable/railway/station/${sf[1]}`;
          if (!stationUrls.includes(url)) stationUrls.push(url);
        }
        const sff = /[?&]SFF=([0-9]+-[0-9]+)/.exec(u);
        if (sff?.[1] && u.includes("ekitan.com")) {
          if (!lineStationCodes.includes(sff[1])) {
            lineStationCodes.push(sff[1]);
          }
        }
        const lm2 = /ekitan\.com\/timetable\/railway\/line\/(\d+)/.exec(u);
        if (lm2?.[1]) {
          const url = `${EKITAN_BASE}/timetable/railway/line/${lm2[1]}`;
          if (!lineUrls.includes(url)) lineUrls.push(url);
        }
      }
    } catch {
      // try the next query phrasing
    }
    if (stationUrls.length > 0) break;
  }
  for (const url of stationUrls.slice(0, 3)) {
    const dirs = await fromStationPage(url);
    if (dirs && dirs.length > 0) return dirs;
  }
  for (const url of lineUrls.slice(0, 2)) {
    const dirs = await fromLinePage(url);
    if (dirs && dirs.length > 0) return dirs;
  }
  for (const code of lineStationCodes.slice(0, 2)) {
    const dirs: EkitanDirection[] = [];
    for (const d of ["d1", "d2"]) {
      const url = `${EKITAN_BASE}/timetable/railway/line-station/${code}/${d}`;
      const html = await fetchPageText(url);
      if (!html) continue;
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "";
      const titleOk = stationCores.some((c) => {
        if (title.includes(c)) return true;
        const short = c.replace(/^(?:大阪|東京|京都|神戸|名古屋)/u, "");
        return short.length >= 2 && title.includes(short);
      });
      if (!titleOk) continue;
      const label = /(\S+方面)の時刻表/u.exec(title)?.[1];
      if (label) dirs.push({ url, label });
    }
    if (dirs.length > 0) return dirs;
  }
  return {
    error: `駅探で「${stationCore}駅」の「${line}」時刻表を見つけられませんでした`,
  };
}

interface TrainTimetableResult {
  weekday: TrainDeparture[];
  holiday: TrainDeparture[];
  sourceUrl: string | null;
  sourceTitle: string | null;
}

/**
 * Per-train timetable for one ride segment (line + boarding station +
 * direction toward the alighting station), cached in
 * train_timetable_cache (7-day TTL). Rail only: the source is the
 * ekitan direction page, whose every departure carries its train
 * type, destination and a link to the train's own page. Also refreshes
 * the minutes-only timetable_cache row from the same fetch so both
 * models stay consistent.
 */
async function ensureTrainTimetable(
  ctx: Ctx,
  line: string,
  station: string,
  toward: string,
): Promise<
  | { ok: true; data: TrainTimetableResult }
  | { ok: false; message: string }
> {
  const db = ctx.db<typeof schema>();
  const stationCore = coreName(station);
  const towardCore = coreName(toward);
  const cacheKey = `${line}|${stationCore}|${towardCore}`;
  const cached = (
    await db
      .select()
      .from(schema.trainTimetableCache)
      .where(eq(schema.trainTimetableCache.cacheKey, cacheKey))
  )[0];
  if (
    cached &&
    cached.fetchedAt &&
    Date.now() - cached.fetchedAt.getTime() < TRAIN_CACHE_TTL_MS
  ) {
    const weekday = parseTrainListJson(cached.weekdayTrains);
    if (weekday.length > 0) {
      return {
        ok: true,
        data: {
          weekday,
          holiday: parseTrainListJson(cached.holidayTrains),
          sourceUrl: cached.sourceUrl,
          sourceTitle: cached.sourceTitle,
        },
      };
    }
  }

  const resolved = await resolveEkitanDirectionsShared(
    (q) => ctx.tool.web_search(q),
    line,
    station,
  );
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const dir = await pickEkitanDirection(
    resolved,
    line,
    stationCore,
    towardCore,
  );
  if (!dir) {
    return { ok: false, message: "方面（方向）を特定できませんでした" };
  }
  const dirNumRaw = /\/d(\d)$/.exec(dir.url)?.[1];
  const dirNum = dirNumRaw != null ? Number(dirNumRaw) : undefined;
  const weekdayHtml = await fetchPageText(`${dir.url}?dt=${nextJstDate(2)}`);
  const holidayHtml = await fetchPageText(`${dir.url}?dt=${nextJstDate(6)}`);
  const weekday = weekdayHtml ? parseEkitanTrains(weekdayHtml, dirNum) : [];
  if (weekday.length < 5) {
    return {
      ok: false,
      message: "駅探の時刻表から列車ごとの発車時刻を読み取れませんでした",
    };
  }
  let holiday = holidayHtml ? parseEkitanTrains(holidayHtml, dirNum) : [];
  if (holiday.length < 5) holiday = weekday;
  const title = weekdayHtml
    ? (/<title>([^<]+)<\/title>/.exec(weekdayHtml)?.[1] ?? null)
    : null;
  const now = new Date();
  const values = {
    cacheKey,
    line,
    station: stationCore,
    toward: towardCore,
    weekdayTrains: JSON.stringify(weekday),
    holidayTrains: JSON.stringify(holiday),
    sourceUrl: dir.url,
    sourceTitle: title,
    fetchedAt: now,
  };
  // Upsert: the board fetches timetables and train details in
  // parallel, and the same train appears in several stations' lists,
  // so a plain select-then-insert races itself into a PK conflict.
  await db
    .insert(schema.trainTimetableCache)
    .values(values)
    .onConflictDoUpdate({
      target: schema.trainTimetableCache.cacheKey,
      set: values,
    });
  // Keep the minutes-only cache in step with the same fetch.
  const minuteValues = {
    line,
    station: stationCore,
    toward: towardCore,
    weekday: JSON.stringify(weekday.map((t) => t.depart)),
    holiday: JSON.stringify(holiday.map((t) => t.depart)),
    sourceUrl: dir.url,
    sourceTitle: title,
    fetchedAt: now,
  };
  const minuteRow = (
    await db
      .select()
      .from(schema.timetableCache)
      .where(eq(schema.timetableCache.line, line))
  ).find((r) => r.station === stationCore && r.toward === towardCore);
  if (minuteRow) {
    await db
      .update(schema.timetableCache)
      .set(minuteValues)
      .where(eq(schema.timetableCache.id, minuteRow.id));
  } else {
    await db.insert(schema.timetableCache).values(minuteValues);
  }
  ctx.invalidateQueries();
  return {
    ok: true,
    data: { weekday, holiday, sourceUrl: dir.url, sourceTitle: title },
  };
}

/**
 * One train's stop list (stop pattern + per-station arrival/departure
 * times) from its ekitan train page, cached in train_detail_cache
 * (7-day TTL). Returns null when the page cannot be read or parsed —
 * callers then fall back to the segment's average ride time.
 */
async function ensureTrainDetail(
  ctx: Ctx,
  line: string,
  train: TrainDeparture,
): Promise<{ type: string; dest: string; stops: TrainStopTime[] } | null> {
  const db = ctx.db<typeof schema>();
  const trainKey = trainKeyOfHref(train.href);
  const cached = (
    await db
      .select()
      .from(schema.trainDetailCache)
      .where(eq(schema.trainDetailCache.trainKey, trainKey))
  )[0];
  if (
    cached &&
    cached.fetchedAt &&
    Date.now() - cached.fetchedAt.getTime() < TRAIN_CACHE_TTL_MS
  ) {
    const stops = parseTrainStopsJson(cached.stops);
    if (stops.length >= 2) {
      return {
        type: cached.trainType || train.type,
        dest: cached.dest || train.dest,
        stops,
      };
    }
  }
  const html = await fetchPageText(EKITAN_BASE + train.href);
  if (!html) return null;
  const stops = parseEkitanTrainStops(html);
  if (stops.length < 2) return null;
  const titleInfo = parseEkitanTrainTitle(html);
  const type = titleInfo.type || train.type;
  const dest = titleInfo.dest || train.dest;
  const values = {
    trainKey,
    line,
    trainType: type,
    dest,
    stops: JSON.stringify(stops),
    fetchedAt: new Date(),
  };
  // Upsert for the same parallel-fetch reason as the timetable cache.
  await db
    .insert(schema.trainDetailCache)
    .values(values)
    .onConflictDoUpdate({
      target: schema.trainDetailCache.trainKey,
      set: values,
    });
  return { type, dest, stops };
}

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
"Searches places by spot name or address so a point on a route can be registered without typing coordinates. Railway stations come from the HeartRails station database (with line names), stations and bus stops also from tag-filtered OpenStreetMap/Photon, and spots/addresses from Nominatim bounded to Japan; results are merged, deduped, and ranked with stations and bus stops first. Renamed stations are bridged to their current official names (e.g. 阪急梅田 → 大阪梅田), so searching the old name still returns the station. Optional nearLat/nearLng bias ranking toward a known nearby point (e.g. the previous spot on the route).",
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
// Station search runs once per name variant: a renamed station
// (阪急梅田 → 大阪梅田) is only in OSM under its current name, and
// each variant's results are scored against that variant.
...stationNameVariants(query).map((v) =>
searchPhoton(
v,
["railway:station", "railway:tram_stop", "building:train_station"],
"駅",
near,
),
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
// Dedupe by name + ~100 m, by real distance: a rounded-coordinate
// key split one station into two candidates whenever its sources
// straddled a rounding boundary (e.g. 大阪梅田駅 at lat 34.7054 vs
// 34.7055 from Photon vs HeartRails). Same-name candidates ~450 m
// apart (阪急 vs 阪神の大阪梅田) stay separate, as they should.
const merged: PlaceCandidate[] = [];
for (const c of all) {
const prev = merged.find(
(m) =>
m.name === c.name &&
haversineKm(m.lat, m.lng, c.lat, c.lng) < 0.1,
);
if (!prev) {
merged.push(c);
} else {
Object.assign(prev, {
...(c.score > prev.score ? c : prev),
line: prev.line ?? c.line,
});
}
}
const places = merged
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

getLineStations: defineAction({
description:
"Returns the ordered station list of one railway line (the line diagram) from the HeartRails station database: every station on the line in travel order with coordinates, plus the two terminal station names. Used so a ride segment's alighting station is picked from the line itself, never from general place search.",
request: z.object({ line: z.string().min(1).max(80) }),
response: z.object({
found: z.boolean(),
line: z.string(),
stations: z.array(
z.object({
name: z.string(),
lat: z.number(),
lng: z.number(),
prefecture: z.string(),
}),
),
}),
async handler(_ctx, args) {
try {
const stations = await heartRailsLineStations(args.line);
return { found: stations.length > 0, line: args.line.trim(), stations };
} catch {
return { found: false, line: args.line.trim(), stations: [] };
}
},
}),

getStationLines: defineAction({
description:
"Returns the railway line names serving one station (HeartRails), so the route editor can offer the lines of the chained boarding station as one-tap choices instead of free-typing a line name.",
request: z.object({ station: z.string().min(1).max(80) }),
response: z.object({ lines: z.array(z.string()) }),
async handler(_ctx, args) {
if (!coreName(args.station)) return { lines: [] };
// Renamed stations resolve through their current official name
// (阪急梅田 → 大阪梅田), whose rows carry the serving lines.
const lines: string[] = [];
for (const core of stationNameVariants(args.station)) {
try {
const j = (await fetchJson(
"https://express.heartrails.com/api/json?method=getStations&name=" +
encodeURIComponent(core),
)) as {
response?: { station?: Array<{ name?: string; line?: string }> };
};
for (const s of j.response?.station ?? []) {
if (s.name === core && s.line && !lines.includes(s.line)) {
lines.push(s.line);
}
}
} catch {
// try the next variant
}
}
return { lines };
},
}),

fetchTimetable: defineAction({
description:
"Automatically fetches the departure timetable for one ride segment (line + boarding station + direction toward the alighting station). For bus segments whose stops were picked from a GTFS-JP line diagram, the times come from the cached GTFS feed (MLIT GTFS Data Repository). For rail, the primary source is the ekitan (駅探) station timetable for that station/line/direction, parsed deterministically (weekday times from a Tuesday service day, holiday times from a Saturday); if that fails, timetable pages found via web search are extracted with model inference. Results are cached in timetable_cache with the source URL and returned. Departure times are never typed by the user.",
request: z.object({
line: z.string().min(1).max(80),
station: z.string().min(1).max(80),
toward: z.string().min(1).max(80),
}),
response: z.object({
ok: z.boolean(),
message: z.string().nullable(),
timetable: timetableShape.nullable(),
}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const stationCore = coreName(args.station);
const towardCore = coreName(args.toward);
// Renamed stations (阪急梅田 → 大阪梅田): station databases and
// ekitan only know the current name, so resolution below matches
// against every variant while the cache key stays the stored name.
const stationCores = stationNameVariants(args.station);
const cachedRow = (
await db
.select()
.from(schema.timetableCache)
.where(eq(schema.timetableCache.line, args.line))
).find((r) => r.station === stationCore && r.toward === towardCore);
const toShape = (row: typeof cachedRow) =>
row
? {
line: row.line,
station: row.station,
toward: row.toward,
weekday: parseMinuteList(row.weekday),
holiday: parseMinuteList(row.holiday),
sourceUrl: row.sourceUrl,
sourceTitle: row.sourceTitle,
fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
}
: null;
const fail = async (message: string) => ({
ok: false,
message,
timetable: toShape(cachedRow),
});

interface Fetched {
weekday: number[];
holiday: number[];
url: string;
title: string | null;
}

// --- bus: GTFS-JP feeds cached from the GTFS Data Repository ---
// Only feeds the user has already opened in the route editor are in
// the cache, so this is a pure DB lookup: the line diagram the user
// picked the stops from identifies the feed, route and direction.
const tryGtfs = async (): Promise<Fetched | null> => {
try {
const rows = await db.select().from(schema.gtfsLineCache);
let best: (typeof rows)[number] | null = null;
let bestExact = false;
for (const row of rows) {
if (!lineNameMatch(args.line, row.routeName)) continue;
const cores = parseGtfsStopsJson(row.stops).map((s) => coreName(s.name));
const bi = cores.indexOf(stationCore);
const ai = cores.indexOf(towardCore);
if (bi < 0 || ai <= bi) continue;
const exact = coreName(row.routeName) === coreName(args.line);
if (!best || (exact && !bestExact)) {
best = row;
bestExact = exact;
}
}
if (!best) return null;
const dep = (
await db
.select()
.from(schema.gtfsDepartures)
.where(
eq(
schema.gtfsDepartures.cacheKey,
`${best.feedKey}|${best.routeId}|${best.directionId}|${stationCore}`,
),
)
)[0];
if (!dep) return null;
const weekday = parseMinuteList(dep.weekday);
if (weekday.length === 0) return null;
const holiday = parseMinuteList(dep.holiday);
const feedRow = (
await db
.select()
.from(schema.gtfsFeedCache)
.where(eq(schema.gtfsFeedCache.feedKey, best.feedKey))
)[0];
const provider = feedRow?.orgName || feedRow?.feedName || "GTFSデータ";
return {
weekday,
holiday,
url: feedRow?.pageUrl ?? "https://gtfs-data.jp/",
title: `GTFSデータ（${provider}${feedRow?.feedName ? `・${feedRow.feedName}` : ""}／GTFSデータリポジトリ）`,
};
} catch {
return null;
}
};

// --- primary: ekitan station timetable (deterministic parse) ---
// Search engines barely index ekitan station pages, so the boarding
// station's ekitan entry point is resolved through whichever ekitan
// URL the search does surface: a station page directly, a train page
// (its sf= parameter IS the station id, SFF= the line-station code),
// or a line page (which lists every station page on the line).
const resolveEkitanDirections =
async (): Promise<EkitanDirection[] | { error: string }> => {
// A station page that lists the requested line -> its directions.
const fromStationPage = async (
stationUrl: string,
): Promise<EkitanDirection[] | null> => {
const html = await fetchPageText(stationUrl);
if (!html) return null;
const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "";
// The page title names the station per operator (梅田駅(大阪メトロ))
// while the stored name may carry another operator's prefix
// (大阪梅田駅), so the city-prefix-stripped short form also counts.
const titleOk = stationCores.some((c) => {
if (title.includes(c)) return true;
const short = c.replace(/^(?:大阪|東京|京都|神戸|名古屋)/u, "");
return short.length >= 2 && title.includes(short);
});
if (!titleOk) return null;
const blocks = parseEkitanStationPage(html);
const block = blocks.find((b) => lineNameMatch(args.line, b.line));
return block ? block.directions : null;
};
// A line page lists every station page on the line; find the
// boarding station's page on it and continue from there.
const fromLinePage = async (
lineUrl: string,
): Promise<EkitanDirection[] | null> => {
const html = await fetchPageText(lineUrl);
if (!html) return null;
const anchorRe =
/href="(\/timetable\/railway\/station\/\d+)"[^>]*>([^<]+)<\/a>/g;
let am: RegExpExecArray | null;
while ((am = anchorRe.exec(html)) !== null) {
const href = am[1];
const name = (am[2] ?? "").replace(/\(.*?\)|（.*?）/gu, "");
if (
href &&
stationCores.some((v) => stationCoreLooseEq(coreName(name), v))
) {
return fromStationPage(EKITAN_BASE + href);
}
}
return null;
};

// Path 1 (deterministic, no search): ekitan's regional index pages
// list every line in the region. The boarding station's prefecture
// (from the HeartRails line diagram) picks the region to scan
// first; the line page then leads to the station page.
const PREFECTURE_AREA: Record<string, number> = {
"北海道": 3,
"青森県": 4, "岩手県": 4, "宮城県": 4, "秋田県": 4, "山形県": 4, "福島県": 4,
"茨城県": 0, "栃木県": 0, "群馬県": 0, "埼玉県": 0, "千葉県": 0, "東京都": 0, "神奈川県": 0,
"新潟県": 6, "山梨県": 6, "長野県": 6,
"富山県": 5, "石川県": 5, "福井県": 5,
"岐阜県": 2, "静岡県": 2, "愛知県": 2, "三重県": 2,
"滋賀県": 1, "京都府": 1, "大阪府": 1, "兵庫県": 1, "奈良県": 1, "和歌山県": 1,
"鳥取県": 7, "島根県": 7, "岡山県": 7, "広島県": 7, "山口県": 7,
"徳島県": 8, "香川県": 8, "愛媛県": 8, "高知県": 8,
"福岡県": 9, "佐賀県": 9, "長崎県": 9, "熊本県": 9, "大分県": 9, "宮崎県": 9, "鹿児島県": 9, "沖縄県": 9,
};
let prefArea: number | null = null;
try {
const stations = await heartRailsLineStations(args.line);
const boarding = stations.find((s) =>
stationCores.some((v) => stationCoreLooseEq(coreName(s.name), v)),
);
if (boarding) {
prefArea = PREFECTURE_AREA[boarding.prefecture] ?? null;
}
} catch {
// region unknown -> scan all regions in order
}
const areaOrder = [
...(prefArea != null ? [prefArea] : []),
...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((a) => a !== prefArea),
];
for (const area of areaOrder) {
const html = await fetchPageText(
`${EKITAN_BASE}/timetable/railway/area/${area}`,
);
if (!html) continue;
const lineRe =
/<a href="(\/timetable\/railway\/line\/\d+)"[^>]*>(?:<span[^>]*>)?([^<]+)/g;
const matches: { url: string; exact: boolean }[] = [];
let lm: RegExpExecArray | null;
while ((lm = lineRe.exec(html)) !== null) {
const href = lm[1];
const name = (lm[2] ?? "").trim();
if (!href || !name) continue;
if (lineNameMatch(args.line, name)) {
matches.push({
url: EKITAN_BASE + href,
exact:
coreName(name).replace(/^JR/u, "") ===
coreName(args.line).replace(/^JR/u, ""),
});
}
}
matches.sort((a, b) => Number(b.exact) - Number(a.exact));
for (const cand of matches.slice(0, 2)) {
const dirs = await fromLinePage(cand.url);
if (dirs && dirs.length > 0) return dirs;
}
if (matches.length > 0) break;
}

// Path 2 (search-based backup): whichever ekitan URL the search
// surfaces — a station page directly, a train page (its sf=
// parameter IS the station id, SFF= the line-station code), or a
// line page.
const stationUrls: string[] = [];
const lineUrls: string[] = [];
const lineStationCodes: string[] = [];
const queries = [
`${args.line} ${stationCore}駅 時刻表 駅探`,
`${stationCore}駅 時刻表 駅探`,
`${args.line} ${stationCore}駅 時刻表`,
];
for (const q of queries) {
try {
const res = await ctx.tool.web_search(q);
for (const r of res.content.results ?? []) {
const u = r.url ?? "";
const sm = /ekitan\.com\/timetable\/railway\/station\/(\d+)/.exec(u);
if (sm?.[1]) {
const url = `${EKITAN_BASE}/timetable/railway/station/${sm[1]}`;
if (!stationUrls.includes(url)) stationUrls.push(url);
continue;
}
const sf = /[?&]sf=(\d+)/.exec(u);
if (sf?.[1] && u.includes("ekitan.com")) {
const url = `${EKITAN_BASE}/timetable/railway/station/${sf[1]}`;
if (!stationUrls.includes(url)) stationUrls.push(url);
}
const sff = /[?&]SFF=([0-9]+-[0-9]+)/.exec(u);
if (sff?.[1] && u.includes("ekitan.com")) {
if (!lineStationCodes.includes(sff[1])) {
lineStationCodes.push(sff[1]);
}
}
const lm2 = /ekitan\.com\/timetable\/railway\/line\/(\d+)/.exec(u);
if (lm2?.[1]) {
const url = `${EKITAN_BASE}/timetable/railway/line/${lm2[1]}`;
if (!lineUrls.includes(url)) lineUrls.push(url);
}
}
} catch {
// try the next query phrasing
}
if (stationUrls.length > 0) break;
}
for (const url of stationUrls.slice(0, 3)) {
const dirs = await fromStationPage(url);
if (dirs && dirs.length > 0) return dirs;
}
for (const url of lineUrls.slice(0, 2)) {
const dirs = await fromLinePage(url);
if (dirs && dirs.length > 0) return dirs;
}
// Path 3: a line-station code from a train result — d1/d2 are the
// two directions; their page titles carry the 方面 labels.
for (const code of lineStationCodes.slice(0, 2)) {
const dirs: EkitanDirection[] = [];
for (const d of ["d1", "d2"]) {
const url = `${EKITAN_BASE}/timetable/railway/line-station/${code}/${d}`;
const html = await fetchPageText(url);
if (!html) continue;
const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? "";
const titleOk = stationCores.some((c) => {
if (title.includes(c)) return true;
const short = c.replace(/^(?:大阪|東京|京都|神戸|名古屋)/u, "");
return short.length >= 2 && title.includes(short);
});
if (!titleOk) continue;
const label = /(\S+方面)の時刻表/u.exec(title)?.[1];
if (label) dirs.push({ url, label });
}
if (dirs.length > 0) return dirs;
}
return {
error: `駅探で「${stationCore}駅」の「${args.line}」時刻表を見つけられませんでした`,
};
};

const tryEkitan = async (): Promise<Fetched | { error: string }> => {
const resolved = await resolveEkitanDirections();
if ("error" in resolved) return resolved;
const dir = await pickEkitanDirection(
resolved,
args.line,
stationCore,
towardCore,
);
if (!dir) return { error: "方面（方向）を特定できませんでした" };
const dirNumRaw = /\/d(\d)$/.exec(dir.url)?.[1];
const dirNum = dirNumRaw != null ? Number(dirNumRaw) : undefined;
const weekdayHtml = await fetchPageText(
`${dir.url}?dt=${nextJstDate(2)}`,
);
const holidayHtml = await fetchPageText(
`${dir.url}?dt=${nextJstDate(6)}`,
);
const weekday = weekdayHtml ? parseEkitanTimes(weekdayHtml, dirNum) : [];
let holiday = holidayHtml ? parseEkitanTimes(holidayHtml, dirNum) : [];
if (weekday.length < 5) {
return { error: "駅探の時刻表から発車時刻を読み取れませんでした" };
}
if (holiday.length < 5) holiday = weekday;
const title = weekdayHtml
? (/<title>([^<]+)<\/title>/.exec(weekdayHtml)?.[1] ?? null)
: null;
return { weekday, holiday, url: dir.url, title };
};

// --- fallback: web-search a timetable page + inference extraction ---
const tryGeneric = async (): Promise<Fetched | null> => {
let pageUrl: string | null = null;
let pageTitle: string | null = null;
let pageText = "";
let candidates: { url: string; title: string | null }[] = [];
try {
const res = await ctx.tool.web_search(
`${args.line} ${stationCore}駅 時刻表 ${towardCore}方面 平日`,
);
const results = res.content.results ?? [];
const preferred = results.filter((r) =>
/(ekitan|jorudan|navitime|ekispert|timetable|time\.|railway|metro|jr|keihan|hankyu|hanshin|keio|odakyu|tobu|seibu|keisei|keikyu|kintetsu|meitetsu|nishitetsu)/i.test(
`${r.source ?? ""} ${r.url ?? ""}`,
),
);
const ordered = [
...preferred,
...results.filter((r) => !preferred.includes(r)),
];
candidates = ordered
.filter((r) => !!r.url)
.slice(0, 6)
.map((r) => ({ url: r.url as string, title: r.title ?? null }));
} catch {
return null;
}
for (const cand of candidates) {
const html = await fetchPageText(cand.url, 15000);
if (!html) continue;
const full = htmlToText(html);
if (full.length < 200) continue;
let text = full.slice(0, 16000);
if (full.length > 16000) {
const anchor = Math.max(
full.indexOf(`${stationCore}駅`),
full.indexOf("時刻表"),
);
if (anchor > 4000) {
text =
full.slice(0, 2000) +
" … " +
full.slice(anchor - 1000, anchor + 15000);
}
}
pageUrl = cand.url;
pageTitle = cand.title;
pageText = text;
break;
}
if (!pageUrl || pageText.length < 200) return null;
const extractSchema = z.object({
weekday: z
.array(z.number().int().min(0).max(1560))
.max(400)
.describe("平日ダイヤの発車時刻（0時からの分数）"),
holiday: z
.array(z.number().int().min(0).max(1560))
.max(400)
.describe("土休日ダイヤの発車時刻（0時からの分数）。読み取れなければ空配列"),
});
try {
const extracted = await ctx.inference.complete(
`次は「${args.line}」の「${stationCore}駅」時刻表ページのテキストです。「${towardCore}」方面（${towardCore}へ向かう列車）の発車時刻だけを、平日ダイヤと土休日ダイヤに分けて抽出してください。テキスト内にその駅・その方面の時刻表が確認できない場合は、推測で作らず両方とも空配列にしてください。時刻は0時からの分数（例: 7:05 → 425）に変換してください。\n\n${pageText}`,
{ schema: extractSchema },
);
if (extracted.weekday.length === 0 && extracted.holiday.length === 0) {
return null;
}
return {
weekday: extracted.weekday,
holiday: extracted.holiday,
url: pageUrl,
title: pageTitle,
};
} catch {
return null;
}
};

let fetched: Fetched | null = null;
let ekitanError = "";
fetched = await tryGtfs();
if (!fetched) {
const ek = await tryEkitan();
if ("error" in ek) {
ekitanError = ek.error;
} else {
fetched = ek;
}
}
if (!fetched) fetched = await tryGeneric();
if (!fetched) {
return fail(
ekitanError ||
"時刻表ページから発車時刻を読み取れませんでした（方面や駅が一致しない可能性があります）",
);
}
const weekday = [...new Set(fetched.weekday)].sort((a, b) => a - b);
const holidaySorted = [...new Set(fetched.holiday)].sort((a, b) => a - b);
const holiday = holidaySorted.length > 0 ? holidaySorted : weekday;
const now = new Date();
const values = {
line: args.line,
station: stationCore,
toward: towardCore,
weekday: JSON.stringify(weekday),
holiday: JSON.stringify(holiday),
sourceUrl: fetched.url,
sourceTitle: fetched.title,
fetchedAt: now,
};
if (cachedRow) {
await db
.update(schema.timetableCache)
.set(values)
.where(eq(schema.timetableCache.id, cachedRow.id));
} else {
await db.insert(schema.timetableCache).values(values);
}
ctx.invalidateQueries();
const saved = (
await db
.select()
.from(schema.timetableCache)
.where(eq(schema.timetableCache.line, args.line))
).find((r) => r.station === stationCore && r.toward === towardCore);
return { ok: true, message: null, timetable: toShape(saved) };
},
}),

fetchTrainTimetable: defineAction({
description:
"Fetches the per-train timetable for one rail ride segment (line + boarding station + direction toward the alighting station) from the ekitan station timetable: every departure with its train type (普通/快速/特急…), destination and a link to the train's own page. Cached in train_timetable_cache for 7 days; the minutes-only timetable cache is refreshed from the same fetch. Rail only — bus (GTFS) and user-registered timetables have no per-train source and return ok:false so the client keeps the minutes-only model for those segments.",
request: z.object({
line: z.string().min(1).max(80),
station: z.string().min(1).max(80),
toward: z.string().min(1).max(80),
}),
response: z.object({
ok: z.boolean(),
message: z.string().nullable(),
weekday: z.array(
z.object({
depart: z.number(),
type: z.string(),
dest: z.string(),
href: z.string(),
}),
),
holiday: z.array(
z.object({
depart: z.number(),
type: z.string(),
dest: z.string(),
href: z.string(),
}),
),
sourceUrl: z.string().nullable(),
sourceTitle: z.string().nullable(),
}),
async handler(ctx, args) {
const res = await ensureTrainTimetable(
ctx,
args.line,
args.station,
args.toward,
);
if (!res.ok) {
return {
ok: false,
message: res.message,
weekday: [],
holiday: [],
sourceUrl: null,
sourceTitle: null,
};
}
return {
ok: true,
message: null,
weekday: res.data.weekday,
holiday: res.data.holiday,
sourceUrl: res.data.sourceUrl,
sourceTitle: res.data.sourceTitle,
};
},
}),

fetchTrainDetails: defineAction({
description:
"Returns the stop pattern of specific trains of one ride segment: for each requested departure minute (of the given day type) at the boarding station, the train's type/destination and its stopping stations with per-station arrival/departure minutes, parsed from the train's own ekitan page and cached in train_detail_cache (7-day TTL). Used to compute real arrival times at the alighting station and mid-segment transfers (local → faster train). Departures whose train page cannot be read are omitted, never fabricated.",
request: z.object({
line: z.string().min(1).max(80),
station: z.string().min(1).max(80),
toward: z.string().min(1).max(80),
dayType: z.enum(["weekday", "holiday"]),
departs: z.array(z.number().int().min(0).max(1560)).max(10),
}),
response: z.object({
ok: z.boolean(),
message: z.string().nullable(),
details: z.array(
z.object({
depart: z.number(),
type: z.string(),
dest: z.string(),
stops: z.array(
z.object({
station: z.string(),
arrive: z.number().nullable(),
depart: z.number().nullable(),
}),
),
}),
),
}),
async handler(ctx, args) {
const tt = await ensureTrainTimetable(
ctx,
args.line,
args.station,
args.toward,
);
if (!tt.ok) {
return { ok: false, message: tt.message, details: [] };
}
const list = args.dayType === "weekday" ? tt.data.weekday : tt.data.holiday;
const details: {
depart: number;
type: string;
dest: string;
stops: TrainStopTime[];
}[] = [];
for (const dep of [...new Set(args.departs)].slice(0, 10)) {
const train = list.find((t) => t.depart === dep);
if (!train) continue;
const detail = await ensureTrainDetail(ctx, args.line, train);
if (!detail) continue;
details.push({
depart: dep,
type: detail.type,
dest: detail.dest,
stops: detail.stops,
});
}
return { ok: true, message: null, details };
},
}),

searchBusFeeds: defineAction({
description:
"Finds bus GTFS-JP feeds published in the MLIT GTFS Data Repository (no API key): feeds serving the area around a point (the repository's extent search) and/or feeds whose operator or feed name matches a query. Returns feed identifiers plus the operator/feed names and license for attribution.",
request: z.object({
query: z.string().max(60),
lat: z.number().min(-90).max(90).nullable(),
lng: z.number().min(-180).max(180).nullable(),
}),
response: z.object({
feeds: z.array(
z.object({
orgId: z.string(),
feedId: z.string(),
orgName: z.string(),
feedName: z.string(),
license: z.string().nullable(),
}),
),
}),
async handler(_ctx, args) {
type Hit = {
orgId: string;
feedId: string;
orgName: string;
feedName: string;
license: string | null;
};
const out = new Map<string, Hit>();
const add = (f: RepoFeedEntry) => {
const orgId = f.organization_id ?? "";
const feedId = f.feed_id ?? "";
if (!orgId || !feedId || out.has(`${orgId}/${feedId}`)) return;
out.set(`${orgId}/${feedId}`, {
orgId,
feedId,
orgName: f.organization_name ?? "",
feedName: f.feed_name ?? "",
license: f.feed_license ?? f.feed_license_id ?? null,
});
};
// Feeds serving the area around the boarding stop.
if (args.lat != null && args.lng != null) {
try {
const extent = [
args.lng - 0.065,
args.lat - 0.055,
args.lng + 0.065,
args.lat + 0.055,
]
.map((n) => n.toFixed(5))
.join(",");
const j = (await fetchJson(
`${GTFS_REPO_API}/files?extent=${extent}`,
20000,
)) as { body?: RepoFeedEntry[] };
for (const f of j.body ?? []) add(f);
} catch {
// name search below may still find feeds
}
}
// Feeds whose operator / feed name matches the query text.
const q = args.query.trim();
if (q) {
const catalog = await repoCatalog();
const qCore = coreName(q);
for (const f of catalog) {
if (
coreName(f.organization_name ?? "").includes(qCore) ||
coreName(f.feed_name ?? "").includes(qCore)
) {
add(f);
}
}
try {
const j = (await fetchJson(
`${GTFS_REPO_API}/feeds?org_name=${encodeURIComponent(q)}`,
15000,
)) as { body?: RepoFeedEntry[] };
for (const f of j.body ?? []) add(f);
} catch {
// catalog matches above are enough
}
}
return { feeds: [...out.values()].slice(0, 12) };
},
}),

getBusFeedRoutes: defineAction({
description:
"Returns the route list of one bus GTFS-JP feed from the MLIT GTFS Data Repository, downloading and caching the feed on first use (later calls read the cache). Includes the operator/feed names and license so the UI can show the data-provider credit.",
request: z.object({
orgId: z.string().min(1).max(120),
feedId: z.string().min(1).max(120),
}),
response: z.object({
found: z.boolean(),
orgName: z.string(),
feedName: z.string(),
license: z.string().nullable(),
pageUrl: z.string().nullable(),
routes: z.array(
z.object({
routeId: z.string(),
name: z.string(),
shortName: z.string(),
}),
),
}),
async handler(ctx, args) {
const ing = await ensureGtfsFeed(ctx, args.orgId, args.feedId);
if (!ing) {
return {
found: false,
orgName: "",
feedName: "",
license: null,
pageUrl: null,
routes: [],
};
}
return {
found: true,
orgName: ing.meta.orgName,
feedName: ing.meta.feedName,
license: ing.meta.license,
pageUrl: ing.meta.pageUrl,
routes: ing.routes,
};
},
}),

getBusRouteStops: defineAction({
description:
"Returns the ordered stop list (the bus line diagram) of one route of a GTFS-JP feed, per direction with the terminal stop name as the direction label. Stops come from the feed cached by getBusFeedRoutes / the timetable fetch, never from general place search.",
request: z.object({
orgId: z.string().min(1).max(120),
feedId: z.string().min(1).max(120),
routeId: z.string().min(1).max(160),
}),
response: z.object({
found: z.boolean(),
directions: z.array(
z.object({
directionId: z.number(),
toward: z.string(),
stops: z.array(
z.object({
name: z.string(),
lat: z.number(),
lng: z.number(),
}),
),
}),
),
}),
async handler(ctx, args) {
const db = ctx.db<typeof schema>();
const ing = await ensureGtfsFeed(ctx, args.orgId, args.feedId);
if (!ing) return { found: false, directions: [] };
const rows = await db
.select()
.from(schema.gtfsLineCache)
.where(eq(schema.gtfsLineCache.feedKey, ing.meta.feedKey));
const directions = rows
.filter((r) => r.routeId === args.routeId)
.sort((a, b) => a.directionId - b.directionId)
.map((r) => ({
directionId: r.directionId,
toward: r.toward,
stops: parseGtfsStopsJson(r.stops),
}))
.filter((d) => d.stops.length >= 2);
return { found: directions.length > 0, directions };
},
}),
} satisfies ActionsModule;
