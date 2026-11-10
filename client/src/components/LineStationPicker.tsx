// Line-diagram station picker for ride segments.
//
// The alighting station of a train/bus ride is always one of the stops
// on the same line, so it is never chosen from general place search:
// the line's stations come from the HeartRails station database in
// travel order (the line diagram), grouped by direction (toward either
// terminal), and only stations reachable from the boarding station in
// the chosen direction are offered. Lines the database does not know
// (most bus routes) fall back to the caller's general place picker.

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { stationCore } from "../lib/predict";
import { PinIcon } from "./icons";
import type { PlaceValue } from "./PlacePicker";

interface LineStation {
  name: string;
  lat: number;
  lng: number;
  prefecture: string;
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]";
const labelCls = "block text-xs font-bold text-[var(--dim)] mb-1";

export function LineStationPicker({
  line,
  onLineChange,
  boarding,
  value,
  onChange,
  fallback,
}: {
  line: string;
  onLineChange: (line: string) => void;
  boarding: PlaceValue;
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
  /** Rendered when the line is not in the station database. */
  fallback: ReactNode;
}) {
  const [linesForStation, setLinesForStation] = useState<string[]>([]);
  const [stations, setStations] = useState<LineStation[] | null>(null);
  const [found, setFound] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState<"fwd" | "rev">("fwd");

  const boardingName = boarding.name.trim();

  // Lines serving the (chained) boarding station: one-tap line choice.
  useEffect(() => {
    if (!boardingName) {
      setLinesForStation([]);
      return;
    }
    let cancelled = false;
    void api
      .getStationLines({ station: boardingName })
      .then((res) => {
        if (!cancelled) setLinesForStation(res.lines);
      })
      .catch(() => {
        if (!cancelled) setLinesForStation([]);
      });
    return () => {
      cancelled = true;
    };
  }, [boardingName]);

  // The line diagram itself.
  useEffect(() => {
    const l = line.trim();
    if (!l) {
      setStations(null);
      setFound(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .getLineStations({ line: l })
      .then((res) => {
        if (cancelled) return;
        setFound(res.found);
        setStations(res.found ? res.stations : null);
      })
      .catch(() => {
        if (cancelled) return;
        setFound(false);
        setStations(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [line]);

  const boardingIdx =
    stations?.findIndex((s) => stationCore(s.name) === stationCore(boardingName)) ??
    -1;
  const selectedIdx =
    stations?.findIndex((s) => stationCore(s.name) === stationCore(value.name)) ??
    -1;

  // Default the direction tab to the side the current alighting station
  // is on (or forward when nothing is chosen yet).
  useEffect(() => {
    if (stations && boardingIdx >= 0 && selectedIdx >= 0) {
      setDir(selectedIdx > boardingIdx ? "fwd" : "rev");
    }
  }, [stations, boardingIdx, selectedIdx]);

  const first = stations?.[0];
  const last = stations?.[stations.length - 1];

  const visible: { st: LineStation; stops: number }[] = (() => {
    if (!stations) return [];
    if (boardingIdx < 0) {
      return stations.map((st, i) => ({ st, stops: i }));
    }
    if (dir === "fwd") {
      return stations
        .slice(boardingIdx + 1)
        .map((st, i) => ({ st, stops: i + 1 }));
    }
    return stations
      .slice(0, boardingIdx)
      .reverse()
      .map((st, i) => ({ st, stops: i + 1 }));
  })();

  const registered = value.lat != null && value.lng != null;

  return (
    <div className="space-y-3">
      <label className="block">
        <span className={labelCls}>路線名</span>
        <input
          aria-label="路線名"
          className={inputCls}
          value={line}
          onChange={(e) => onLineChange(e.target.value)}
          placeholder="例: 京阪本線"
        />
      </label>
      {linesForStation.length > 0 && (
        <div>
          <p className="text-xs text-[var(--dim)]">
            {boardingName}を通る路線（タップで選択）
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {linesForStation.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={line === l}
                onClick={() => onLineChange(l)}
                className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                  line === l
                    ? "border-[var(--accent)] bg-[#123c26] text-[#4ade80]"
                    : "border-[var(--border)] text-[var(--dim)]"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <span className={labelCls}>降車駅（路線図から選択）</span>
        {!line.trim() && (
          <div>
            <p className="text-xs text-[var(--dim)]">
              路線を選ぶと、その路線の駅一覧（路線図）から降車駅を選べます。バスの場合は、下のGTFS路線図からも選べます。
            </p>
            <div className="mt-2">
              <BusGtfsPicker
                boarding={boarding}
                value={value}
                onChange={onChange}
                onLineChange={onLineChange}
              />
            </div>
          </div>
        )}
        {line.trim() && loading && (
          <p className="text-xs text-[var(--dim)]">路線図を読み込み中…</p>
        )}
        {line.trim() && !loading && found === false && (
          <div>
            <p className="text-xs text-[var(--warn)]">
              この路線の鉄道の路線図データは見つかりませんでした。バスの場合は下のGTFS路線図（GTFSデータリポジトリ収録の事業者のみ）からも選べます。
            </p>
            <div className="mt-2">
              <BusGtfsPicker
                boarding={boarding}
                value={value}
                onChange={onChange}
                onLineChange={onLineChange}
              />
            </div>
            <div className="mt-3">{fallback}</div>
          </div>
        )}
        {found && stations && first && last && (
          <div>
            <div
              className="flex rounded-md border border-[var(--border)]"
              role="group"
              aria-label="方向の選択"
            >
              {(
                [
                  ["fwd", `${last.name} 方面`],
                  ["rev", `${first.name} 方面`],
                ] as ["fwd" | "rev", string][]
              ).map(([d, label]) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={dir === d}
                  onClick={() => setDir(d)}
                  className={`flex-1 px-2 py-1.5 text-xs font-bold ${
                    dir === d
                      ? "bg-[var(--surface)] text-[var(--text)]"
                      : "text-[var(--dim)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {boardingIdx < 0 && boardingName && (
              <p className="mt-1.5 text-xs text-[var(--warn)]">
                乗車駅「{boardingName}」がこの路線図に見つからないため、全駅を表示しています。
              </p>
            )}
            {registered && selectedIdx >= 0 && (
              <p className="mt-1.5 text-xs">
                <span className="rounded bg-[#123c26] px-1.5 py-0.5 font-bold text-[#4ade80]">
                  <PinIcon size={11} className="mr-0.5 inline" />
                  降車駅登録済み
                </span>{" "}
                <span className="font-bold">{value.name}</span>
              </p>
            )}
            <ul
              className="mt-1.5 max-h-64 space-y-1 overflow-y-auto"
              aria-label="路線図の駅一覧"
            >
              {boardingIdx >= 0 && (
                <li className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 opacity-70">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--warn)]" />
                  <span className="text-sm font-bold">
                    {stations[boardingIdx]?.name}
                  </span>
                  <span className="text-xs text-[var(--dim)]">乗車駅</span>
                </li>
              )}
              {visible.map(({ st, stops }) => {
                const isPicked =
                  stationCore(st.name) === stationCore(value.name);
                return (
                  <li key={st.name}>
                    <button
                      type="button"
                      aria-pressed={isPicked}
                      onClick={() =>
                        onChange({
                          name: st.name,
                          address: st.prefecture,
                          lat: st.lat,
                          lng: st.lng,
                          line,
                        })
                      }
                      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left ${
                        isPicked
                          ? "border-[var(--accent)] bg-[#123c26]"
                          : "border-[var(--border)] bg-[var(--bg)]"
                      }`}
                    >
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          isPicked ? "bg-[var(--accent)]" : "bg-[var(--dim)]"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-bold">
                        {st.name}
                      </span>
                      {boardingIdx >= 0 && (
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          {stops}駅目
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
              {visible.length === 0 && (
                <li className="px-1 py-2 text-xs text-[var(--dim)]">
                  この方向には降車できる駅がありません。反対方向のタブを確認してください。
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- bus line diagram from GTFS-JP (GTFS Data Repository) ----------
//
// For bus ride segments, the alighting stop must also come from the
// line itself — never from general place search. Feeds published in
// the MLIT GTFS Data Repository (no API key) provide exactly that:
// the user picks a feed (auto-suggested around the boarding stop, or
// found by operator name), then a route, then a direction, and the
// route's stops appear in travel order just like the rail diagram.
// Operators not in the repository (e.g. 京都市バス, which is ODPT-only
// and needs a free access token) honestly fall back to the caller's
// general place picker.

interface BusFeedHit {
  orgId: string;
  feedId: string;
  orgName: string;
  feedName: string;
  license: string | null;
}
interface BusRouteHit {
  routeId: string;
  name: string;
  shortName: string;
}
interface BusStopHit {
  name: string;
  lat: number;
  lng: number;
}
interface BusDirectionHit {
  directionId: number;
  toward: string;
  stops: BusStopHit[];
}
interface BusCredit {
  orgName: string;
  feedName: string;
  license: string | null;
  pageUrl: string | null;
}

function BusGtfsPicker({
  boarding,
  value,
  onChange,
  onLineChange,
}: {
  boarding: PlaceValue;
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
  onLineChange: (line: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [feeds, setFeeds] = useState<BusFeedHit[] | null>(null);
  const [feedState, setFeedState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [feed, setFeed] = useState<BusFeedHit | null>(null);
  const [credit, setCredit] = useState<BusCredit | null>(null);
  const [routes, setRoutes] = useState<BusRouteHit[] | null>(null);
  const [routesState, setRoutesState] = useState<"idle" | "loading" | "error">("idle");
  const [route, setRoute] = useState<BusRouteHit | null>(null);
  const [directions, setDirections] = useState<BusDirectionHit[] | null>(null);
  const [stopsState, setStopsState] = useState<"idle" | "loading" | "error">("idle");
  const [dirId, setDirId] = useState<number | null>(null);

  const boardingLat = boarding.lat;
  const boardingLng = boarding.lng;

  const runSearch = (q: string) => {
    setFeedState("loading");
    void api
      .searchBusFeeds({ query: q, lat: boardingLat, lng: boardingLng })
      .then((res) => {
        setFeeds(res.feeds);
        setFeedState("done");
      })
      .catch(() => setFeedState("error"));
  };

  // Auto-suggest feeds around the boarding stop (no typing needed).
  useEffect(() => {
    if (boardingLat != null && boardingLng != null) runSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardingLat, boardingLng]);

  const pickFeed = (f: BusFeedHit) => {
    setFeed(f);
    setCredit(null);
    setRoutes(null);
    setRoute(null);
    setDirections(null);
    setDirId(null);
    setRoutesState("loading");
    void api
      .getBusFeedRoutes({ orgId: f.orgId, feedId: f.feedId })
      .then((res) => {
        if (!res.found) {
          setRoutesState("error");
          return;
        }
        setCredit({
          orgName: res.orgName,
          feedName: res.feedName,
          license: res.license,
          pageUrl: res.pageUrl,
        });
        setRoutes(res.routes);
        setRoutesState("idle");
      })
      .catch(() => setRoutesState("error"));
  };

  const pickRoute = (r: BusRouteHit) => {
    if (!feed) return;
    setRoute(r);
    setDirections(null);
    setDirId(null);
    setStopsState("loading");
    onLineChange(r.name);
    void api
      .getBusRouteStops({ orgId: feed.orgId, feedId: feed.feedId, routeId: r.routeId })
      .then((res) => {
        if (!res.found) {
          setStopsState("error");
          return;
        }
        setDirections(res.directions);
        setDirId(res.directions[0]?.directionId ?? null);
        setStopsState("idle");
      })
      .catch(() => setStopsState("error"));
  };

  const direction = directions?.find((d) => d.directionId === dirId) ?? directions?.[0] ?? null;
  const stops = direction?.stops ?? [];
  const boardingIdx = stops.findIndex(
    (s) => stationCore(s.name) === stationCore(boarding.name),
  );
  const visibleStops: { st: BusStopHit; stops: number }[] =
    boardingIdx >= 0
      ? stops.slice(boardingIdx + 1).map((st, i) => ({ st, stops: i + 1 }))
      : stops.map((st, i) => ({ st, stops: i }));
  const providerName = credit?.orgName || feed?.orgName || "";

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5">
      <p className="text-xs font-bold">バス路線図（GTFS）から選ぶ</p>
      <p className="mt-0.5 text-xs text-[var(--dim)]">
        GTFSデータリポジトリ（国土交通省）に収録されたバス事業者・路線だけが対象です。
      </p>
      <div className="mt-2 flex gap-1.5">
        <input
          aria-label="バス事業者・路線名で検索"
          className={inputCls}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="事業者名・路線名で検索（例: 西宮市）"
        />
        <button
          type="button"
          className="shrink-0 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-bold"
          onClick={() => runSearch(query.trim())}
        >
          検索
        </button>
      </div>

      {feedState === "loading" && (
        <p className="mt-2 text-xs text-[var(--dim)]">バス路線を探しています…</p>
      )}
      {feedState === "error" && (
        <p className="mt-2 text-xs text-[var(--warn)]">
          バス路線の検索に失敗しました。
          <button type="button" className="ml-1 font-bold underline" onClick={() => runSearch(query.trim())}>
            再試行
          </button>
        </p>
      )}
      {feedState === "done" && feeds && feeds.length === 0 && (
        <p className="mt-2 text-xs text-[var(--dim)]">
          近くにGTFS収録のバス路線は見つかりませんでした。事業者名で検索するか、下の検索から降車バス停を登録してください。
        </p>
      )}
      {feeds && feeds.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="バス事業者・路線グループの選択">
          {feeds.map((f) => {
            const isPicked = feed?.orgId === f.orgId && feed?.feedId === f.feedId;
            return (
              <button
                key={`${f.orgId}/${f.feedId}`}
                type="button"
                aria-pressed={isPicked}
                onClick={() => pickFeed(f)}
                className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                  isPicked
                    ? "border-[var(--accent)] bg-[#123c26] text-[#4ade80]"
                    : "border-[var(--border)] text-[var(--dim)]"
                }`}
              >
                {f.orgName} {f.feedName}
              </button>
            );
          })}
        </div>
      )}

      {feed && routesState === "loading" && (
        <p className="mt-2 text-xs text-[var(--dim)]">
          路線データを読み込んでいます（初回はGTFSデータの取得に少し時間がかかります）…
        </p>
      )}
      {feed && routesState === "error" && (
        <p className="mt-2 text-xs text-[var(--warn)]">
          この事業者の路線データを読み込めませんでした。
          <button type="button" className="ml-1 font-bold underline" onClick={() => pickFeed(feed)}>
            再試行
          </button>
        </p>
      )}
      {feed && routes && routes.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-[var(--dim)]">路線を選んでください</p>
          <ul className="mt-1 max-h-44 space-y-1 overflow-y-auto" aria-label="バス路線一覧">
            {routes.map((r) => {
              const isPicked = route?.routeId === r.routeId;
              return (
                <li key={r.routeId}>
                  <button
                    type="button"
                    aria-pressed={isPicked}
                    onClick={() => pickRoute(r)}
                    className={`w-full rounded-md border px-2.5 py-2 text-left text-sm font-bold ${
                      isPicked
                        ? "border-[var(--accent)] bg-[#123c26]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}
                  >
                    {r.name}
                    {r.shortName && r.shortName !== r.name ? (
                      <span className="ml-1 text-xs text-[var(--dim)]">{r.shortName}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {route && stopsState === "loading" && (
        <p className="mt-2 text-xs text-[var(--dim)]">バス停一覧を読み込んでいます…</p>
      )}
      {route && stopsState === "error" && (
        <p className="mt-2 text-xs text-[var(--warn)]">
          この路線のバス停一覧を読み込めませんでした。
          <button type="button" className="ml-1 font-bold underline" onClick={() => pickRoute(route)}>
            再試行
          </button>
        </p>
      )}
      {route && directions && direction && (
        <div className="mt-2">
          <div className="flex rounded-md border border-[var(--border)]" role="group" aria-label="バスの方向の選択">
            {directions.map((d) => (
              <button
                key={d.directionId}
                type="button"
                aria-pressed={direction.directionId === d.directionId}
                onClick={() => setDirId(d.directionId)}
                className={`flex-1 px-2 py-1.5 text-xs font-bold ${
                  direction.directionId === d.directionId
                    ? "bg-[var(--surface)] text-[var(--text)]"
                    : "text-[var(--dim)]"
                }`}
              >
                {d.toward} 方面
              </button>
            ))}
          </div>
          {boardingIdx < 0 && boarding.name.trim() && (
            <p className="mt-1.5 text-xs text-[var(--warn)]">
              乗車バス停「{boarding.name}」がこの路線図に見つからないため、全バス停を表示しています。
            </p>
          )}
          <ul className="mt-1.5 max-h-64 space-y-1 overflow-y-auto" aria-label="バス路線図のバス停一覧">
            {boardingIdx >= 0 && (
              <li className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 opacity-70">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--warn)]" />
                <span className="text-sm font-bold">{stops[boardingIdx]?.name}</span>
                <span className="text-xs text-[var(--dim)]">乗車バス停</span>
              </li>
            )}
            {visibleStops.map(({ st, stops: n }) => {
              const isPicked = stationCore(st.name) === stationCore(value.name);
              return (
                <li key={`${st.name}-${st.lat}-${st.lng}`}>
                  <button
                    type="button"
                    aria-pressed={isPicked}
                    onClick={() =>
                      onChange({
                        name: st.name,
                        address: providerName,
                        lat: st.lat,
                        lng: st.lng,
                        line: route.name,
                      })
                    }
                    className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left ${
                      isPicked
                        ? "border-[var(--accent)] bg-[#123c26]"
                        : "border-[var(--border)] bg-[var(--surface)]"
                    }`}
                  >
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        isPicked ? "bg-[var(--accent)]" : "bg-[var(--dim)]"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-bold">{st.name}</span>
                    {boardingIdx >= 0 && (
                      <span className="shrink-0 text-xs text-[var(--dim)]">{n}停目</span>
                    )}
                  </button>
                </li>
              );
            })}
            {visibleStops.length === 0 && (
              <li className="px-1 py-2 text-xs text-[var(--dim)]">
                この方向には降車できるバス停がありません。反対方向のタブを確認してください。
              </li>
            )}
          </ul>
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            データ提供: {providerName}
            {credit?.feedName ? `（${credit.feedName}）` : ""}
            {credit?.license ? `／${credit.license}` : ""}／GTFSデータリポジトリ
            {credit?.pageUrl && (
              <>
                {" "}
                <a href={credit.pageUrl} target="_blank" rel="noreferrer" className="underline">
                  出典ページ
                </a>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
