# Data Plan

## Context provenance
- `経路をいくつか登録できて、1つを選択する。その経路上の位置情報と乗り換え情報からどの電車に乗れそうか表示する。例えば今いる場所から歩いて10分で次の駅に着くならダイヤから10分後の電車を提案する。さらに個人の歩く道とスピードを学習してより正確な案内をしたり、リアルタイムの遅延情報を取り入れたりといった工夫もほしい` (verbatim build request; defines the whole product: route registration + selection, position-aware catchable-train prediction from timetable, walking-speed learning, live delay info)
- No external context applied beyond the verbatim request; routes/timetables are the user's own data, entered by them (no nationwide timetable API exists to import from).

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
