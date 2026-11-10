// Route editor: builds one bidirectional route as an ordered list of
// segments. Segment 0 is always the origin; walk and ride segments follow.
// One route covers both directions (outbound + return): places, stations
// and walking times are shared; ride segments may carry an optional
// return-direction timetable. Points are registered with PlacePicker
// (spot-name / address search, map pins, current position) — raw
// coordinates never appear in the UI. Segments form one continuous chain:
// each segment starts where the previous one ended, pre-filled
// automatically when a segment is added, so the user registers each spot
// only once; editing a shared spot updates both adjoining segments
// (reordering or removing a segment re-links the chain). Because the
// start is always chained in, segments after the first show their start
// spot as a read-only display — no second place picker to fill in.

import { useState, type ReactNode } from "react";
import {
formatTimes,
parseTimes,
type RouteLike,
} from "../lib/predict";
import { LineStationPicker } from "./LineStationPicker";
import {
ChevronDownIcon,
ChevronUpIcon,
FlagIcon,
PinIcon,
PlusIcon,
TrainIcon,
TrashIcon,
WalkIcon,
} from "./icons";
import { PlacePicker, emptyPlace, type PlaceValue } from "./PlacePicker";

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
  timesReturnWeekday: string;
  timesReturnHoliday: string;
  place: PlaceValue;
  toPlace: PlaceValue;
}

// A route is one continuous chain of spots: the origin's spot is where the
// first segment starts, and every later segment starts exactly where the
// previous one ended. The editor keeps that chain in sync so the user
// registers each spot only once — editing a spot updates both sides.
function endPlaceOf(d: DraftSegment): PlaceValue {
  return d.type === "origin" ? d.place : d.toPlace;
}

// Re-link a draft list after reorder/removal: every segment's start place
// becomes the previous segment's end place.
function rechain(list: DraftSegment[]): DraftSegment[] {
  const out = [...list];
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (!prev || !cur) continue;
    const end = endPlaceOf(prev);
    out[i] = { ...cur, place: { ...end }, fromLabel: end.name };
  }
  return out;
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
    timesReturnWeekday: "",
    timesReturnHoliday: "",
    place: emptyPlace(),
    toPlace: emptyPlace(),
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
    timesReturnWeekday: formatTimes(s.returnWeekday),
    timesReturnHoliday: formatTimes(s.returnHoliday),
    place: {
      name:
        s.placeName ??
        (s.type === "origin"
          ? s.toLabel
          : s.type === "ride"
            ? (s.station ?? s.fromLabel)
            : s.fromLabel),
      address: s.placeAddress ?? "",
      lat: s.lat,
      lng: s.lng,
    },
    toPlace:
      s.type === "origin"
        ? // The origin has a single spot: it is both its start and its end.
          {
            name: s.placeName ?? s.toLabel,
            address: s.placeAddress ?? "",
            lat: s.lat,
            lng: s.lng,
          }
        : {
            name: s.toPlaceName ?? s.toLabel,
            address: s.toPlaceAddress ?? "",
            lat: s.toLat,
            lng: s.toLng,
          },
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
    placeName: string | null;
    placeAddress: string | null;
    toPlaceName: string | null;
    toPlaceAddress: string | null;
    toLat: number | null;
    toLng: number | null;
    departuresReturn: { weekday: number[]; holiday: number[] } | null;
  }[];
}

function numOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
}

function placeFields(p: PlaceValue): {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
} {
  if (p.lat == null || p.lng == null) {
    return { name: null, address: null, lat: null, lng: null };
  }
  return {
    name: p.name.trim() || null,
    address: p.address.trim() || null,
    lat: p.lat,
    lng: p.lng,
  };
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
      if (!d.place.name.trim()) {
        return { ok: false, error: `${label}: 出発地点名を入力してください` };
      }
      const pf = placeFields(d.place);
      segments.push({
        type: "origin",
        fromLabel: "",
        toLabel: d.place.name.trim(),
        station: null,
        line: null,
        baseWalkMin: null,
        accessMin: null,
        rideMin: null,
        departures: null,
        lat: pf.lat,
        lng: pf.lng,
        placeName: pf.name,
        placeAddress: pf.address,
        toPlaceName: null,
        toPlaceAddress: null,
        toLat: null,
        toLng: null,
        departuresReturn: null,
      });
    } else if (d.type === "walk") {
      if (!d.place.name.trim() || !d.toPlace.name.trim()) {
        return { ok: false, error: `${label}: 徒歩の出発地と到着地を入力してください` };
      }
      const base = numOrNull(d.baseWalkMin);
      if (base == null || base <= 0) {
        return { ok: false, error: `${label}: 徒歩分数（目安）を入力してください` };
      }
      const pf = placeFields(d.place);
      const tf = placeFields(d.toPlace);
      segments.push({
        type: "walk",
        fromLabel: d.place.name.trim(),
        toLabel: d.toPlace.name.trim(),
        station: null,
        line: null,
        baseWalkMin: Math.round(base),
        accessMin: null,
        rideMin: null,
        departures: null,
        lat: pf.lat,
        lng: pf.lng,
        placeName: pf.name,
        placeAddress: pf.address,
        toPlaceName: tf.name,
        toPlaceAddress: tf.address,
        toLat: tf.lat,
        toLng: tf.lng,
        departuresReturn: null,
      });
    } else {
      if (!d.line.trim() || !d.place.name.trim() || !d.toPlace.name.trim()) {
        return { ok: false, error: `${label}: 路線名・乗車駅・降車駅を入力してください` };
      }
      // Departure times are NOT entered at registration: they are
      // fetched automatically from the route (line + stations) when
      // the departure board needs them. Any timetable already stored
      // on an older route is preserved as-is.
      const weekday = parseTimes(d.timesWeekday);
      const holiday = d.timesHoliday.trim()
        ? parseTimes(d.timesHoliday)
        : weekday;
      const rideMin = numOrNull(d.rideMin);
      if (rideMin == null || rideMin <= 0) {
        return { ok: false, error: `${label}: 乗車時間（分）を入力してください` };
      }
      const retWeekday = parseTimes(d.timesReturnWeekday);
      const retHoliday = d.timesReturnHoliday.trim()
        ? parseTimes(d.timesReturnHoliday)
        : retWeekday;
      const departuresReturn =
        retWeekday.length > 0
          ? { weekday: retWeekday, holiday: retHoliday }
          : null;
      const pf = placeFields(d.place);
      const tf = placeFields(d.toPlace);
      segments.push({
        type: "ride",
        fromLabel: d.fromLabel.trim(),
        toLabel: d.toPlace.name.trim(),
        station: d.place.name.trim(),
        line: d.line.trim(),
        baseWalkMin: null,
        accessMin: Math.max(0, Math.round(numOrNull(d.accessMin) ?? 3)),
        rideMin: Math.round(rideMin),
        departures: { weekday, holiday },
        lat: pf.lat,
        lng: pf.lng,
        placeName: pf.name,
        placeAddress: pf.address,
        toPlaceName: tf.name,
        toPlaceAddress: tf.address,
        toLat: tf.lat,
        toLng: tf.lng,
        departuresReturn,
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

// Read-only display of a segment's start spot. From the second spot on,
// the start is always the previous spot, chained in automatically — there
// is nothing to search or register here. To change it, the user edits the
// previous segment's end spot (or the origin).
function ChainedStart({
  label,
  value,
}: {
  label: string;
  value: PlaceValue;
}) {
  const registered = value.lat != null && value.lng != null;
  return (
    <div>
      <span className={labelCls}>{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">
            {value.name || "（前の地点）"}
          </span>
          {value.address && (
            <span className="block truncate text-xs text-[var(--dim)]">
              {value.address}
            </span>
          )}
        </span>
        {registered && (
          <span className="shrink-0 rounded bg-[#123c26] px-1.5 py-0.5 text-xs font-bold text-[#4ade80]">
            <PinIcon size={11} className="mr-0.5 inline" />
            地点登録済み
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        前の地点から自動で入ります。変更したいときは、前の区間の到着地を変更してください。
      </p>
    </div>
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
      return rechain(next);
    });
  };
  const remove = (idx: number) => {
    setDrafts((prev) => rechain(prev.filter((_, i) => i !== idx)));
  };
  const add = (type: "walk" | "ride") => {
    setDrafts((prev) => {
      const draft = newDraftSegment(type);
      const last = prev[prev.length - 1];
      if (last) {
        // The new segment starts where the previous one ended — the user
        // only registers the new end point.
        const end = endPlaceOf(last);
        draft.place = { ...end };
        draft.fromLabel = end.name;
        if (type === "ride" && end.line) draft.line = end.line;
      }
      return [...prev, draft];
    });
  };

  // Chain-aware place edits: changing a segment's start also rewrites the
  // previous segment's end (and vice versa), so a shared spot is edited in
  // one place and stays consistent on both sides.
  const setStartPlace = (idx: number, value: PlaceValue) => {
    setDrafts((prev) => {
      const next = [...prev];
      const cur = next[idx];
      if (!cur) return prev;
      next[idx] = {
        ...cur,
        place: value,
        fromLabel: value.name,
        // Picking a station candidate also fills the line name (when the
        // user has not typed one) — one less thing to enter by hand.
        ...(cur.type === "ride" && value.line && !cur.line.trim()
          ? { line: value.line }
          : {}),
      };
      if (cur.type === "origin") {
        const following = next[idx + 1];
        if (following) {
          next[idx + 1] = {
            ...following,
            place: { ...value },
            fromLabel: value.name,
          };
        }
      } else {
        const before = next[idx - 1];
        if (before) {
          next[idx - 1] =
            before.type === "origin"
              ? { ...before, place: { ...value } }
              : { ...before, toPlace: { ...value } };
        }
      }
      return next;
    });
  };
  const setEndPlace = (idx: number, value: PlaceValue) => {
    setDrafts((prev) => {
      const next = [...prev];
      const cur = next[idx];
      if (!cur) return prev;
      next[idx] = {
        ...cur,
        toPlace: value,
        toLabel: value.name,
        ...(cur.type === "ride" && value.line && !cur.line.trim()
          ? { line: value.line }
          : {}),
      };
      const following = next[idx + 1];
      if (following) {
        next[idx + 1] = {
          ...following,
          place: { ...value },
          fromLabel: value.name,
          // The following ride segment has no start picker anymore (its
          // boarding station is this chained spot), so a station pick
          // here is what can still fill its line name.
          ...(following.type === "ride" && value.line && !following.line.trim()
            ? { line: value.line }
            : {}),
        };
      }
      return next;
    });
  };

  const placeNear = (p: PlaceValue): { lat: number; lng: number } | null =>
    p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;

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
            placeholder="例: 自宅⇔会社"
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
        行き・帰りは分けず、1つの経路で登録します。どちらの方向かはアプリが現在地から自動で判定します。余裕は「ホームに着いてから発車まで」に確保する安全マージンです。
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
              <div className="mt-2">
                <PlacePicker
                  label="地点名"
                  namePlaceholder="例: 自宅"
                  value={d.place}
                  onChange={(place) => setStartPlace(idx, place)}
                />
              </div>
            )}

            {d.type === "walk" && (
              <div className="mt-2 space-y-3">
                <ChainedStart label="出発地" value={d.place} />
                <PlacePicker
                  label="到着地"
                  namePlaceholder="例: 最寄り駅"
                  value={d.toPlace}
                  onChange={(toPlace) => setEndPlace(idx, toPlace)}
                  near={placeNear(d.place)}
                />
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
                  徒歩分数は両方向で共通です。実際に歩いた記録がたまると、あなたのペースに合わせて自動で補正されます。
                </p>
              </div>
            )}

            {d.type === "ride" && (
              <div className="mt-2 space-y-3">
                <ChainedStart label="乗車駅" value={d.place} />
                <LineStationPicker
                  line={d.line}
                  onLineChange={(line) => update(d.key, { line })}
                  boarding={d.place}
                  value={d.toPlace}
                  onChange={(toPlace) => setEndPlace(idx, toPlace)}
                  fallback={
                    <PlacePicker
                      label="降車駅・バス停"
                      namePlaceholder="例: 池袋"
                      value={d.toPlace}
                      onChange={(toPlace) => setEndPlace(idx, toPlace)}
                      near={placeNear(d.place)}
                    />
                  }
                />
                <div className="grid grid-cols-2 gap-2">
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
                <p className="text-xs text-[var(--dim)]">
                  発車時刻は登録不要です。発車案内を開いたときに、路線と乗車駅・降車駅から時刻表を自動で取得して使います。駅・路線・乗車時間は行き・帰り両方向で共通です。路線図から降車駅を選べるのは鉄道の路線と、GTFSデータリポジトリ（国土交通省）に収録されたバス路線です。収録されていないバス路線は、降車バス停を検索で登録してください（その場合、時刻表の自動取得は対象外です）。
                </p>
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
