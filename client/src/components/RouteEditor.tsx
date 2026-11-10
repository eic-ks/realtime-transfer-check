// Route editor: builds one route as an ordered list of segments.
// Segment 0 is always the origin; walk and ride segments follow.
// Ride segments carry the user's own timetable text (parsed on save).

import { useState, type ReactNode } from "react";
import {
formatTimes,
generateTimes,
parseTimes,
type RouteLike,
} from "../lib/predict";
import {
ChevronDownIcon,
ChevronUpIcon,
FlagIcon,
PlusIcon,
TrainIcon,
TrashIcon,
WalkIcon,
} from "./icons";

export interface DraftSegment {
  key: number;
  type: "origin" | "walk" | "ride";
  fromLabel: string;
  toLabel: string;
  station: string;
  line: string;
  baseWalkMin: string;
  accessMin: string;
  rideMin: string;
  timesWeekday: string;
  timesHoliday: string;
  lat: string;
  lng: string;
}

let keyCounter = 1;
export function newDraftSegment(
  type: "origin" | "walk" | "ride",
): DraftSegment {
  return {
    key: keyCounter++,
    type,
    fromLabel: "",
    toLabel: "",
    station: "",
    line: "",
    baseWalkMin: type === "walk" ? "10" : "",
    accessMin: type === "ride" ? "3" : "",
    rideMin: type === "ride" ? "15" : "",
    timesWeekday: "",
    timesHoliday: "",
    lat: "",
    lng: "",
  };
}

export function routeToDraft(route: RouteLike): DraftSegment[] {
  return route.segments.map((s) => ({
    key: keyCounter++,
    type: s.type,
    fromLabel: s.fromLabel,
    toLabel: s.toLabel,
    station: s.station ?? "",
    line: s.line ?? "",
    baseWalkMin: s.baseWalkMin != null ? String(s.baseWalkMin) : "",
    accessMin: s.accessMin != null ? String(s.accessMin) : "",
    rideMin: s.rideMin != null ? String(s.rideMin) : "",
    timesWeekday: formatTimes(s.departuresWeekday),
    timesHoliday: formatTimes(s.departuresHoliday),
    lat: s.lat != null ? String(s.lat) : "",
    lng: s.lng != null ? String(s.lng) : "",
  }));
}

export interface RoutePayload {
  name: string;
  bufferMin: number;
  segments: {
    type: "origin" | "walk" | "ride";
    fromLabel: string;
    toLabel: string;
    station: string | null;
    line: string | null;
    baseWalkMin: number | null;
    accessMin: number | null;
    rideMin: number | null;
    departures: { weekday: number[]; holiday: number[] } | null;
    lat: number | null;
    lng: number | null;
  }[];
}

function numOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
}

export function draftToPayload(
  name: string,
  bufferMin: string,
  drafts: DraftSegment[],
): { ok: true; payload: RoutePayload } | { ok: false; error: string } {
  if (!name.trim()) return { ok: false, error: "経路名を入力してください" };
  if (drafts.length === 0 || drafts[0]?.type !== "origin") {
    return { ok: false, error: "先頭は出発地点にしてください" };
  }
  const segments: RoutePayload["segments"] = [];
  for (const [i, d] of drafts.entries()) {
    const label = `区間${i + 1}`;
    if (d.type === "origin") {
      if (!d.toLabel.trim()) {
        return { ok: false, error: `${label}: 出発地点名を入力してください` };
      }
      const lat = numOrNull(d.lat);
      const lng = numOrNull(d.lng);
      if ((lat == null) !== (lng == null)) {
        return { ok: false, error: `${label}: 緯度と経度は両方入力してください` };
      }
      segments.push({
        type: "origin",
        fromLabel: "",
        toLabel: d.toLabel.trim(),
        station: null,
        line: null,
        baseWalkMin: null,
        accessMin: null,
        rideMin: null,
        departures: null,
        lat,
        lng,
      });
    } else if (d.type === "walk") {
      if (!d.fromLabel.trim() || !d.toLabel.trim()) {
        return { ok: false, error: `${label}: 徒歩の出発地と到着地を入力してください` };
      }
      const base = numOrNull(d.baseWalkMin);
      if (base == null || base <= 0) {
        return { ok: false, error: `${label}: 徒歩分数（目安）を入力してください` };
      }
      segments.push({
        type: "walk",
        fromLabel: d.fromLabel.trim(),
        toLabel: d.toLabel.trim(),
        station: null,
        line: null,
        baseWalkMin: Math.round(base),
        accessMin: null,
        rideMin: null,
        departures: null,
        lat: null,
        lng: null,
      });
    } else {
      if (!d.line.trim() || !d.station.trim() || !d.toLabel.trim()) {
        return { ok: false, error: `${label}: 路線名・乗車駅・降車駅を入力してください` };
      }
      const weekday = parseTimes(d.timesWeekday);
      const holiday = d.timesHoliday.trim()
        ? parseTimes(d.timesHoliday)
        : weekday;
      if (weekday.length === 0) {
        return { ok: false, error: `${label}: 平日の発車時刻を1本以上入力してください` };
      }
      const rideMin = numOrNull(d.rideMin);
      if (rideMin == null || rideMin <= 0) {
        return { ok: false, error: `${label}: 乗車時間（分）を入力してください` };
      }
      const lat = numOrNull(d.lat);
      const lng = numOrNull(d.lng);
      if ((lat == null) !== (lng == null)) {
        return { ok: false, error: `${label}: 乗車駅の緯度と経度は両方入力してください` };
      }
      segments.push({
        type: "ride",
        fromLabel: d.fromLabel.trim(),
        toLabel: d.toLabel.trim(),
        station: d.station.trim(),
        line: d.line.trim(),
        baseWalkMin: null,
        accessMin: Math.max(0, Math.round(numOrNull(d.accessMin) ?? 3)),
        rideMin: Math.round(rideMin),
        departures: { weekday, holiday },
        lat,
        lng,
      });
    }
  }
  const buffer = numOrNull(bufferMin);
  return {
    ok: true,
    payload: {
      name: name.trim(),
      bufferMin: buffer != null ? Math.max(0, Math.round(buffer)) : 1,
      segments,
    },
  };
}

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]";
const labelCls = "block text-xs font-bold text-[var(--dim)] mb-1";

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

interface EditorProps {
  title: string;
  initialName: string;
  initialBuffer: number;
  initialSegments: DraftSegment[];
  saving: boolean;
  saveError: string | null;
  onSave: (payload: RoutePayload) => void;
  onCancel: () => void;
}

export function RouteEditor({
  title,
  initialName,
  initialBuffer,
  initialSegments,
  saving,
  saveError,
  onSave,
  onCancel,
}: EditorProps) {
  const [name, setName] = useState(initialName);
  const [bufferMin, setBufferMin] = useState(String(initialBuffer));
  const [drafts, setDrafts] = useState<DraftSegment[]>(initialSegments);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState<
    Record<number, { first: string; last: string; interval: string; target: string }>
  >({});

  const update = (key: number, patch: Partial<DraftSegment>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.key === key ? { ...d, ...patch } : d)),
    );
  };
  const move = (idx: number, dir: -1 | 1) => {
    setDrafts((prev) => {
      const next = [...prev];
      const target = idx + dir;
      const a = next[idx];
      const b = next[target];
      if (!a || !b) return prev;
      next[idx] = b;
      next[target] = a;
      return next;
    });
  };
  const remove = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };
  const add = (type: "walk" | "ride") => {
    setDrafts((prev) => {
      const draft = newDraftSegment(type);
      const last = prev[prev.length - 1];
      if (type === "walk" && last) draft.fromLabel = last.toLabel;
      if (type === "ride" && last) draft.fromLabel = last.toLabel;
      return [...prev, draft];
    });
  };

  const applyGenerator = (key: number) => {
    const g = gen[key];
    if (!g) return;
    const parse = (t: string) => {
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      return m && m[1] && m[2] ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const first = parse(g.first);
    const last = parse(g.last);
    const interval = Number(g.interval);
    if (first == null || last == null || !Number.isFinite(interval)) return;
    const times = generateTimes(first, last, interval);
    if (times.length === 0) return;
    const text = formatTimes(times);
    update(
      key,
      g.target === "holiday" ? { timesHoliday: text } : { timesWeekday: text },
    );
  };

  const handleSave = () => {
    const result = draftToPayload(name, bufferMin, drafts);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onSave(result.payload);
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="text-base font-black">{title}</h2>
      <div className="mt-3 grid grid-cols-[1fr_110px] gap-3">
        <Field label="経路名">
          <input
            aria-label="経路名"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 通勤（行き）"
          />
        </Field>
        <Field label="余裕（分）">
          <input
            aria-label="余裕分数"
            className={inputCls}
            type="number"
            min={0}
            max={30}
            value={bufferMin}
            onChange={(e) => setBufferMin(e.target.value)}
          />
        </Field>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        余裕は「ホームに着いてから発車まで」に確保する安全マージンです。
      </p>

      <div className="mt-4 space-y-3">
        {drafts.map((d, idx) => (
          <div
            key={d.key}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-black">
                {d.type === "origin" ? (
                  <FlagIcon size={16} className="text-[var(--accent)]" />
                ) : d.type === "walk" ? (
                  <WalkIcon size={16} className="text-[var(--warn)]" />
                ) : (
                  <TrainIcon size={16} className="text-[var(--accent)]" />
                )}
                {idx + 1}.{" "}
                {d.type === "origin"
                  ? "出発地点"
                  : d.type === "walk"
                    ? "徒歩"
                    : "電車"}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`区間${idx + 1}を上へ`}
                  className="rounded p-1.5 text-[var(--dim)] disabled:opacity-30"
                  disabled={idx <= 1}
                  onClick={() => move(idx, -1)}
                >
                  <ChevronUpIcon size={16} />
                </button>
                <button
                  type="button"
                  aria-label={`区間${idx + 1}を下へ`}
                  className="rounded p-1.5 text-[var(--dim)] disabled:opacity-30"
                  disabled={idx === 0 || idx === drafts.length - 1}
                  onClick={() => move(idx, 1)}
                >
                  <ChevronDownIcon size={16} />
                </button>
                <button
                  type="button"
                  aria-label={`区間${idx + 1}を削除`}
                  className="rounded p-1.5 text-[var(--danger)] disabled:opacity-30"
                  disabled={idx === 0}
                  onClick={() => remove(idx)}
                >
                  <TrashIcon size={16} />
                </button>
              </span>
            </div>

            {d.type === "origin" && (
              <div className="mt-2 space-y-2">
                <Field label="地点名">
                  <input
                    aria-label="出発地点名"
                    className={inputCls}
                    value={d.toLabel}
                    onChange={(e) => update(d.key, { toLabel: e.target.value })}
                    placeholder="例: 自宅"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="緯度（任意・現在地補正用）">
                    <input
                      aria-label="出発地点の緯度"
                      className={inputCls}
                      inputMode="decimal"
                      value={d.lat}
                      onChange={(e) => update(d.key, { lat: e.target.value })}
                      placeholder="35.6812"
                    />
                  </Field>
                  <Field label="経度（任意）">
                    <input
                      aria-label="出発地点の経度"
                      className={inputCls}
                      inputMode="decimal"
                      value={d.lng}
                      onChange={(e) => update(d.key, { lng: e.target.value })}
                      placeholder="139.7671"
                    />
                  </Field>
                </div>
              </div>
            )}

            {d.type === "walk" && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="出発地">
                    <input
                      aria-label="徒歩の出発地"
                      className={inputCls}
                      value={d.fromLabel}
                      onChange={(e) =>
                        update(d.key, { fromLabel: e.target.value })
                      }
                      placeholder="例: 自宅"
                    />
                  </Field>
                  <Field label="到着地">
                    <input
                      aria-label="徒歩の到着地"
                      className={inputCls}
                      value={d.toLabel}
                      onChange={(e) =>
                        update(d.key, { toLabel: e.target.value })
                      }
                      placeholder="例: 最寄り駅"
                    />
                  </Field>
                </div>
                <Field label="徒歩分数（目安）">
                  <input
                    aria-label="徒歩分数"
                    className={inputCls}
                    type="number"
                    min={1}
                    max={240}
                    value={d.baseWalkMin}
                    onChange={(e) =>
                      update(d.key, { baseWalkMin: e.target.value })
                    }
                  />
                </Field>
                <p className="text-xs text-[var(--dim)]">
                  実際に歩いた記録がたまると、あなたのペースに合わせて自動で補正されます。
                </p>
              </div>
            )}

            {d.type === "ride" && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="路線名">
                    <input
                      aria-label="路線名"
                      className={inputCls}
                      value={d.line}
                      onChange={(e) => update(d.key, { line: e.target.value })}
                      placeholder="例: JR山手線"
                    />
                  </Field>
                  <Field label="乗車駅">
                    <input
                      aria-label="乗車駅"
                      className={inputCls}
                      value={d.station}
                      onChange={(e) =>
                        update(d.key, { station: e.target.value })
                      }
                      placeholder="例: 新宿"
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="降車駅">
                    <input
                      aria-label="降車駅"
                      className={inputCls}
                      value={d.toLabel}
                      onChange={(e) =>
                        update(d.key, { toLabel: e.target.value })
                      }
                      placeholder="例: 池袋"
                    />
                  </Field>
                  <Field label="乗車時間（分）">
                    <input
                      aria-label="乗車時間"
                      className={inputCls}
                      type="number"
                      min={1}
                      max={600}
                      value={d.rideMin}
                      onChange={(e) =>
                        update(d.key, { rideMin: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="乗換・入場（分）">
                    <input
                      aria-label="乗り換え入場分数"
                      className={inputCls}
                      type="number"
                      min={0}
                      max={60}
                      value={d.accessMin}
                      onChange={(e) =>
                        update(d.key, { accessMin: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <Field label="平日の発車時刻">
                  <textarea
                    aria-label="平日の発車時刻"
                    className={`${inputCls} tnum`}
                    rows={3}
                    value={d.timesWeekday}
                    onChange={(e) =>
                      update(d.key, { timesWeekday: e.target.value })
                    }
                    placeholder={"7: 02 12 22 32\n8: 02 12"}
                  />
                </Field>
                <Field label="土休日の発車時刻（空欄なら平日と同じ）">
                  <textarea
                    aria-label="土休日の発車時刻"
                    className={`${inputCls} tnum`}
                    rows={2}
                    value={d.timesHoliday}
                    onChange={(e) =>
                      update(d.key, { timesHoliday: e.target.value })
                    }
                    placeholder={"8: 05 25 45"}
                  />
                </Field>
                <details className="rounded-md border border-[var(--border)] p-2">
                  <summary className="cursor-pointer text-xs font-bold text-[var(--dim)]">
                    等間隔ダイヤから時刻を生成
                  </summary>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    <Field label="始発">
                      <input
                        aria-label="生成元の始発時刻"
                        className={inputCls}
                        type="time"
                        value={gen[d.key]?.first ?? ""}
                        onChange={(e) =>
                          setGen((p) => ({
                            ...p,
                            [d.key]: {
                              first: e.target.value,
                              last: p[d.key]?.last ?? "",
                              interval: p[d.key]?.interval ?? "10",
                              target: p[d.key]?.target ?? "weekday",
                            },
                          }))
                        }
                      />
                    </Field>
                    <Field label="終発">
                      <input
                        aria-label="生成元の終発時刻"
                        className={inputCls}
                        type="time"
                        value={gen[d.key]?.last ?? ""}
                        onChange={(e) =>
                          setGen((p) => ({
                            ...p,
                            [d.key]: {
                              first: p[d.key]?.first ?? "",
                              last: e.target.value,
                              interval: p[d.key]?.interval ?? "10",
                              target: p[d.key]?.target ?? "weekday",
                            },
                          }))
                        }
                      />
                    </Field>
                    <Field label="間隔（分）">
                      <input
                        aria-label="生成元の間隔分数"
                        className={inputCls}
                        type="number"
                        min={1}
                        max={120}
                        value={gen[d.key]?.interval ?? "10"}
                        onChange={(e) =>
                          setGen((p) => ({
                            ...p,
                            [d.key]: {
                              first: p[d.key]?.first ?? "",
                              last: p[d.key]?.last ?? "",
                              interval: e.target.value,
                              target: p[d.key]?.target ?? "weekday",
                            },
                          }))
                        }
                      />
                    </Field>
                    <Field label="対象">
                      <select
                        aria-label="生成先の日種"
                        className={inputCls}
                        value={gen[d.key]?.target ?? "weekday"}
                        onChange={(e) =>
                          setGen((p) => ({
                            ...p,
                            [d.key]: {
                              first: p[d.key]?.first ?? "",
                              last: p[d.key]?.last ?? "",
                              interval: p[d.key]?.interval ?? "10",
                              target: e.target.value,
                            },
                          }))
                        }
                      >
                        <option value="weekday">平日</option>
                        <option value="holiday">土休日</option>
                      </select>
                    </Field>
                  </div>
                  <button
                    type="button"
                    className="mt-2 rounded-md bg-[var(--accent-dim)] px-3 py-1.5 text-xs font-bold text-white"
                    onClick={() => applyGenerator(d.key)}
                  >
                    時刻を生成して反映
                  </button>
                </details>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="乗車駅の緯度（任意）">
                    <input
                      aria-label="乗車駅の緯度"
                      className={inputCls}
                      inputMode="decimal"
                      value={d.lat}
                      onChange={(e) => update(d.key, { lat: e.target.value })}
                      placeholder="35.6896"
                    />
                  </Field>
                  <Field label="乗車駅の経度（任意）">
                    <input
                      aria-label="乗車駅の経度"
                      className={inputCls}
                      inputMode="decimal"
                      value={d.lng}
                      onChange={(e) => update(d.key, { lng: e.target.value })}
                      placeholder="139.7006"
                    />
                  </Field>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-bold"
          onClick={() => add("walk")}
        >
          <PlusIcon size={15} /> 徒歩区間
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-bold"
          onClick={() => add("ride")}
        >
          <PlusIcon size={15} /> 電車区間
        </button>
      </div>

      {(error || saveError) && (
        <p className="mt-3 text-sm font-bold text-[var(--danger)]">
          {error ?? saveError}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-black text-[#0b2013] disabled:opacity-50"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "保存中…" : "保存する"}
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--border)] px-4 py-2.5 text-sm font-bold"
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}
