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
          <p className="text-xs text-[var(--dim)]">
            路線を選ぶと、その路線の駅一覧（路線図）から降車駅を選べます。
          </p>
        )}
        {line.trim() && loading && (
          <p className="text-xs text-[var(--dim)]">路線図を読み込み中…</p>
        )}
        {line.trim() && !loading && found === false && (
          <div>
            <p className="text-xs text-[var(--warn)]">
              この路線の路線図データが見つかりませんでした（バス路線など）。降車バス停は下の検索から登録してください。
            </p>
            <div className="mt-2">{fallback}</div>
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
