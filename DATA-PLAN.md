# Data Plan

## Context provenance
- `経路をいくつか登録できて、1つを選択する。その経路上の位置情報と乗り換え情報からどの電車に乗れそうか表示する。例えば今いる場所から歩いて10分で次の駅に着くならダイヤから10分後の電車を提案する。さらに個人の歩く道とスピードを学習してより正確な案内をしたり、リアルタイムの遅延情報を取り入れたりといった工夫もほしい` (verbatim build request; defines the whole product: route registration + selection, position-aware catchable-train prediction from timetable, walking-speed learning, live delay info)
- No external context applied beyond the verbatim request; routes/timetables are the user's own data, entered by them (no nationwide timetable API exists to import from).
- Edit request (2026-11-10, verbatim in the edit brief): points on a route must be registerable by address input or by dropping a pin on a map, best by spot name (e.g. 金閣寺）; raw latitude/longitude must not appear in the UI; outbound/return must be unified into one route with the direction auto-detected (movement direction / current position first, a manual switch only as a last-resort correction); never raise the user's cognitive load.

## Tested sources (edit: place search)
### Nominatim (OpenStreetMap) search + reverse geocoding
**Used by**: `searchPlaces` / `reverseGeocode` actions (route-editor place registration)
**Test command**: `curl -s -H 'User-Agent: MuseTransitApp/1.0' 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&addressdetails=1&q=金閣寺'`
**Sample output**: result[0] = name `金閣寺`, display_name `金閣寺, 金閣寺町, 馬喰町, 北区, 京都市, 京都府, 603-8361, 日本`, lat 35.0395293, lon 135.7295373, class amenity / type place_of_worship. Same endpoint family the hotel artifact already uses server-side.
**Processing**: candidates (name / address / internal lat,lng / kind 駅・スポット・住所・地点） are shown for the user to tap; coordinates are stored internally on the segment (`lat/lng` = start point, `to_lat/to_lng` = end point, plus place names/addresses) and never displayed or typed. Map pinning uses the bundled Meta map control (`hatch-maps.js` copied into `client/src/assets/`, `map_helpers.mjs`): search candidates appear as numbered pins and tapping a pin registers that place; the control's public API exposes no arbitrary-tap coordinate readout, so free-form pin drops are not offered. Reverse geocoding names a point picked from the current GPS position.

## Station / bus-stop search overhaul (edit 2026-11-10)
- User report (verbatim in the edit brief): 「駅やバス停の検索性が悪すぎる。」
- Diagnosis (tested 2026-11-10): the old `searchPlaces` was a single unbounded Nominatim free-text query, limit 6. Measured failures: `新宿駅` → administrative areas in China/Brazil/Mongolia, then station entrances （出入口） instead of the station; `金閣寺前` (Kyoto City Bus stop) → a traffic signal of the same name; bus stops classified as 住所 (highway catch-all); no Japan bounding, no name-match filtering, no dedupe beyond exact coordinates.
- Fix: `searchPlaces` now fans out in parallel and merges with name scoring (exact > prefix > contains > bigram-Dice ≥ 0.34 for fuzzy sources), dedupe by name + ~100 m, stations/bus stops ranked first, optional `nearLat/nearLng` bias (the picker passes the chained previous spot's coordinates from RouteEditor). If no bus stop surfaces and the query lacks バス停, one extra Nominatim pass with ` バス停` appended runs (its tokenizer only then restricts to bus_stop features). Station candidates carry a `line`, and RouteEditor auto-fills an empty 路線名 when a station candidate is picked.
- Verified via the built action: `新宿駅` → 新宿駅 grouped per operator with line names (was: foreign cities); `出町柳` → 京阪本線/叡山電鉄本線 stations, then 出町柳駅前 bus stops; `四条烏丸` → the actual intersection bus stops; `金閣寺前` → 金閣寺道 bus stop (the real stop serving 金閣寺; the exact-name stop is absent from OSM); `京都市北区金閣寺町1` / `東京都新宿区西新宿1-1-1` → exact 番地-level addresses (GSI).

### HeartRails Express station search (new)
**Used by**: `searchPlaces` (railway station candidates + line names)
**Endpoint**: `https://express.heartrails.com/api/json?method=getStations&name=<name without 駅>`
**Test**: `curl 'https://express.heartrails.com/api/json?method=getStations&name=出町柳'` → 京阪本線/叡山電鉄本線 entries with x/y coordinates, prefecture, prev/next stations. `name=新宿` → per-line entries at the same coordinates (grouped client-side by name + ~100 m).

### Photon (OSM autocomplete), tag-filtered (new)
**Used by**: `searchPlaces` (station + bus-stop candidates)
**Endpoint**: `https://photon.komoot.io/api/?q=<name>&limit=10&bbox=124.0,24.0,146.0,45.5&osm_tag=railway:station&osm_tag=railway:tram_stop&osm_tag=building:train_station` and `&osm_tag=highway:bus_stop`
**Test**: `q=新宿&osm_tag=railway:station` → 新宿 station nodes per operator; `q=金閣寺前&osm_tag=highway:bus_stop` → 金閣寺道 (Kyoto) among fuzzy matches — fuzzy results are name-plausibility-filtered before merging.

### GSI address search (new)
**Used by**: `searchPlaces` （番地-level Japanese addresses, which Nominatim cannot resolve: `京都市北区金閣寺町1` and `東京都新宿区西新宿1-1-1` both return [] from Nominatim)
**Endpoint**: `https://msearch.gsi.go.jp/address-search/AddressSearch?q=<address>`
**Test**: `q=京都市北区金閣寺町1` → `京都府京都市北区金閣寺町１番地` at [135.729279, 35.039619].

### Nominatim changes
Same endpoint as below, now `viewbox=124.0,24.0,146.0,46.0&bounded=1` (Japan only), limit 12; `traffic_signals` and `subway_entrance` results dropped; kind mapping extended （バス停 for highway/bus_stop + public_transport, 駅 for railway station/tram_stop/halt + building/train_station).

### Rejected: Overpass API name search
**Test**: exact-name QL queries for 金閣寺前/四条烏丸/出町柳駅 against overpass-api.de and overpass.kumi.systems, plus an area-scoped regex variant — every attempt timed out (>40 s per host; regex area scan >120 s total). Too slow/unreliable for an interactive picker.

## Chained spots in the route editor (edit 2026-11-10)
- User request (verbatim in the edit brief): in route registration, only the first spot should need manual entry; from the second spot on, the previous spot must automatically become the departure point. Previously the first segment added after the origin was NOT pre-filled (the origin's spot lives in `place`, but `add()` read the previous segment's `toPlace`), and editing a spot did not propagate to the adjoining segment.
- Fix (client-only, `RouteEditor.tsx`): segments are one continuous chain. `endPlaceOf()` treats the origin's spot as its end; `add()` pre-fills the new segment's start from it; place edits are chain-aware (`setStartPlace`/`setEndPlace` rewrite the neighboring segment's matching end); reorder/removal re-links via `rechain()`. No schema or server change.

## Chained start spots are display-only (edit 2026-11-10)
- User request (verbatim in the edit brief): since the departure spot is now auto-filled (chained), the place-registration fields for the second and later spots are unnecessary.
- Change (client-only, `RouteEditor.tsx`): walk segments no longer render a full PlacePicker for 出発地 and ride segments none for 乗車駅 — the chained start spot is shown read-only (name, address, 地点登録済み badge) with a note that it comes from the previous spot and is changed by editing the previous segment's end. Full pickers remain only where a new spot is actually registered: the origin and each segment's end （到着地 / 降車駅）. Because a ride segment's boarding station can no longer be picked directly, picking a station candidate as the previous segment's end now also fills the following ride segment's empty 路線名 (as does adding a ride segment after a station end spot). No schema or server change.

## Line-diagram station picker + automatic timetables (edit 2026-11-10)
- User request (verbatim in the edit brief): for train/bus ride segments the alighting station must be picked from the line diagram (per line, per direction — up/down), not general place search; departure times must not be entered by the user at registration — they should be fetched automatically from the route, because the app is launched from any position at any time on the route and must do the transfer time arithmetic itself.
- Line diagram: new `getLineStations` action wraps HeartRails `getStations&line=<line>` (tested: `京阪本線` returns every station with x/y, prefecture, prev/next; order rebuilt from the prev/next chain). New `getStationLines` action wraps `getStations&name=<station>` for the lines serving the chained boarding station (one-tap line chips). Client `LineStationPicker`: direction tabs are the two terminals （○○方面）, the list shows only stations reachable from the boarding station in that direction, in travel order, with 駅目 counts and the boarding station pinned on top. Lines absent from HeartRails (most bus routes) honestly fall back to the general PlacePicker with a note.
- Bus limitation (explicit, disclosed in the editor): the line-diagram picker and the ekitan automatic timetable cover RAIL lines only. No tested source offers a server-rendered bus route diagram: HeartRails is rail-only, and ekitan's bus section (bus.ekitan.com) is a separate legacy service without the clean area→line→stop structure the rail side has (checked 2026-11-10: the route-bus company pages carry no stop-list links). For bus segments the alighting stop is therefore registered via the general place search, and automatic timetable fetching is attempted only via the generic operator-page fallback, which may fail; the RouteEditor ride-section note and the LineStationPicker fallback message both state this where the user meets it.
- Automatic timetables: registration no longer asks for any departure times (the four textareas and the interval generator were removed from RouteEditor; previously stored timetables on older routes are preserved untouched and used as-is). New `timetable_cache` table (migration 0004; unique key line+station+toward) and `fetchTimetable` action. The board auto-fetches any ride segment that has neither a stored nor a cached timetable when the route is opened, shows per-segment status （自動取得済み + source link + age / 取得中 / 取得できませんでした + 再試行）, and merges cached times into predictions via `applyTimetables()` in predict.ts (keyed by line + station-core + toward-core, 駅 suffix stripped).

### Ekitan （駅探） timetable source (fetchTimetable primary; tested 2026-11-10)
- Why ekitan: its station timetable pages are fully server-rendered HTML, so a plain server `fetch` gets the whole day's departures as text. NAVITIME answers 403 (CloudFront) to server fetches and ジョルダン is JavaScript-rendered; `ctx.tool.web_search` essentially never returns ekitan timetable pages, so the station entry point is resolved WITHOUT search (below).
- URL shapes (all verified live): station page `https://ekitan.com/timetable/railway/station/<id>` (per line: direction links with 「○○方面」 anchor text); line page `https://ekitan.com/timetable/railway/line/<id>` (lists every station page on the line); regional index `https://ekitan.com/timetable/railway/area/<0-9>` （関東0/関西1/東海2/北海道3/東北4/北陸5/甲信越6/中国7/四国8/九州・沖縄9; lists every line in the region); direction timetable `https://ekitan.com/timetable/railway/line-station/<code>/d1|d2`.
- Day types: a `?dt=YYYYMMDD` query picks the service day — a Tuesday renders the weekday timetable, a Saturday the holiday one (verified: 出町柳 京阪本線 weekday 203 departures incl. commuter expresses vs Saturday 183 without; `?dw=` is ignored by the site).
- Resolution (deterministic): boarding station's prefecture from the HeartRails line diagram → regional index → line link (name match, JR-/線-normalized) → line page → boarding station page → that line's direction links. Direction is chosen by matching the 方面 label's station names against the HeartRails station order on the alighting side (fallbacks: label names the alighting station; a train page whose stop list runs boarding → alighting). Search-result URLs (station page / train page `sf=`=station id, `SFF=`=line-station code / line page) remain as backup paths. Extraction is a deterministic regex over the text under すべての時刻 — no model inference. Fallback if ekitan fails: the older web-search + `ctx.inference` extraction over other timetable pages; if that also fails, an honest error and nothing is fabricated.
- Verified via the built action: 京阪本線 出町柳→三条 (weekday 203 / holiday 183 departures, first 5:00/5:20/5:36/5:52/5:58 — matches the ekitan page), 京阪本線 三条→出町柳 (opposite direction d2 chosen correctly), JR山手線 新宿→池袋 (title ＪＲ山手線 池袋・田端・上野方面， ~370 weekday departures from 4:43).

## Direction unification (edit)
- Schema: migration 0003 adds place fields + `to_lat/to_lng` + `departures_return` to `segments`, and `direction`/`direction_source` to `app_settings`. One route is bidirectional: places/stations/walk times/ride times are shared; only ride timetables may differ per direction (return timetable optional, falls back to the outbound one).
- Client: `reversedRoute()` builds the return view (segment ids preserved, so pace learning applies both ways); `detectDirection()` auto-detects from GPS — movement along the route first, then proximity to either end (within 800 m, and only when within 3 km of the route polyline). Detection runs on the board's continuous GPS watch and persists via `setDirection`. A small correction link （行きに切り替え/帰りに切り替え） is the only manual control; a manual correction is stored with source `manual` and auto-detection does not override it (「自動判定に戻す」 releases it).

## Tested sources
### ctx.tool.web_search (delay/status lookup)
**Used by**: `refreshLineStatus` action (per registered line, cached)
**Test command**: probe-ctx snippet `ctx.tool.web_search("JR山手線 遅延情報 現在の運行情報")`
**Sample output**: result[0] = JR東日本公式 `https://traininfo.jreast.co.jp/train_info/line.aspx?gid=1&lineid=yamanoteline` with snippet containing `運行情報・運休情報 - 平常運転` and a 遅延証明書 table with per-time-band delay minutes (e.g. `| - | 10分 | 10分 |`). Structured fields: results[].title/url/source/snippet.
**Processing**: server action searches `<路線名> 運行情報 遅延`; status classified from snippet keywords (運転見合わせ/運休 → suspended, 遅延/遅れ → delayed, 平常運転/通常運行 → normal); delay minutes extracted from `最大約N分` / `N分程度の遅れ` / 遅延証明書 patterns when present; stored in `line_status` cache with source URL (verbatim from result) + fetched_at; UI shows status, minutes, source link, and age; user can also set a manual delay-minutes override per line that shifts predictions. Predictions recompute client-side every second from cached status.

### Rejected: rti-giken free delay JSON (https://tetsudo.rti-giken.jp/free/delay.json)
**Test command**: `curl -s 'https://tetsudo.rti-giken.jp/free/delay.json'` (two attempts)
**Sample output**: TLS connects, then `Empty reply from server` / timeout (exit 52) both times.
**Why rejected**: unreachable from this environment; web_search against official operator pages works and carries provenance URLs.

## Imagery
Imagery not needed: this is a functional real-time transit board — the hero is the live countdown/next-train display; there are no visual subjects to photograph or illustrate. Icons are Lucide glyphs.

## Long-term data behavior
- **Refresh policy**: line status is cached per line name in `line_status`; `refreshLineStatus` re-searches on user tap and on route open when cache is older than 10 minutes (client-triggered). Timetable/routes/walk-logs are user-owned and change only via explicit user actions. No scheduled cron: delay data is only meaningful at open/tap time.
- **Growth**: routes bounded by user entry; walk_logs grows one row per recorded walk segment (kept, used for learning averages; displayed recent-first, capped display at 50).
- **Ordering**: routes by created order with an `is_active` selection; departures sorted ascending within a day-part; walk logs newest first.
- **Time semantics**: all times are JST wall-clock minutes-of-day for timetables; walk log timestamps are instants rendered in the viewer's local timezone (user is in JST). Countdowns computed from the device clock each second against Asia/Tokyo time-of-day.
