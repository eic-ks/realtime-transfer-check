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
//
// The list is drawn as a vertical timeline (a rail with a dot per
// segment). Between every pair of segments — and before the start —
// sits an insert strip: tapping it drops a new walk/ride segment in at
// exactly that position, so adding a spot mid-route no longer means
// "append at the end, then tap ↑ repeatedly". The strip before the
// start PREPENDS: a new origin plus a connecting segment to the old
// start, which is how the start moves one spot earlier without losing
// the old start spot.

import { useState, type ReactNode } from "react";
import {
formatTimes,
parseTimes,
type RouteLike,
} from "../lib/predict";
import { LineStationPicker } from "./LineStationPicker";
import {
BusIcon,
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

/** The three ways to move between two spots on a route. "train" and
 * "bus" both produce ride segments; the vehicle only changes how the
 * segment is displayed and which line diagram the stop is picked
 * from — the prediction math is the same. */
export type SegmentKind = "walk" | "train" | "bus";

export interface DraftSegment {
  key: number;
  type: "origin" | "walk" | "ride";
  /** Ride segments only: train or bus. */
  vehicle: "train" | "bus";
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
  vehicle: "train" | "bus" = "train",
): DraftSegment {
  return {
    key: keyCounter++,
    type,
    vehicle,
    fromLabel: "",
    toLabel: "",
    station: "",
    line: "",
    baseWalkMin: type === "walk" ? "10" : "",
    // Access (in-station / transfer) minutes are opt-in: blank
    // means none. Ride minutes are never entered — they are
    // derived from the timetable when the board fetches it.
    accessMin: "",
    rideMin: "",
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
    vehicle: s.vehicle === "bus" ? ("bus" as const) : ("train" as const),
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
    vehicle: "train" | "bus" | null;
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
        vehicle: null,
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
        vehicle: null,
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
        return {
          ok: false,
          error:
            d.vehicle === "bus"
              ? `${label}: 路線名・乗車バス停・降車バス停を入力してください`
              : `${label}: 路線名・乗車駅・降車駅を入力してください`,
        };
      }
      // Departure times are NOT entered at registration: they are
      // fetched automatically from the route (line + stations) when
      // the departure board needs them. Any timetable already stored
      // on an older route is preserved as-is.
      const weekday = parseTimes(d.timesWeekday);
      const holiday = d.timesHoliday.trim()
        ? parseTimes(d.timesHoliday)
        : weekday;
      // Ride minutes are NOT entered either: the board derives
      // them from the fetched timetable (line diagram / train stop
      // times). A value stored on an older route is passed through
      // untouched as a fallback.
      const rideMin = numOrNull(d.rideMin);
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
        vehicle: d.vehicle,
        fromLabel: d.fromLabel.trim(),
        toLabel: d.toPlace.name.trim(),
        station: d.place.name.trim(),
        line: d.line.trim(),
        baseWalkMin: null,
        // Opt-in: blank stays null (no access minutes). Only a
        // value the user actually typed is stored.
        accessMin:
          numOrNull(d.accessMin) != null
            ? Math.max(0, Math.round(numOrNull(d.accessMin) as number))
            : null,
        rideMin: rideMin != null ? Math.round(rideMin) : null,
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

// Insert strip on the timeline rail, rendered between two segment cards
// (or before the start). Tapping the ＋ expands a three-way choice —
// 徒歩 / 電車 / バス — and the picked segment is inserted at exactly
// this position; the chain re-links around it, so the following
// segment now starts at the new spot once the user registers it.
function InsertStrip({
  label,
  verb,
  open,
  onToggle,
  onPick,
}: {
  label: string;
  /** "入れる" between segments, "つなぐ" before the start. */
  verb: "入れる" | "つなぐ";
  open: boolean;
  onToggle: () => void;
  onPick: (kind: SegmentKind) => void;
}) {
  if (!open) {
    return (
      <div className="relative py-1">
        <button
          type="button"
          aria-label={label}
          aria-expanded={false}
          onClick={onToggle}
          className="flex items-center gap-2"
        >
          <span className="flex w-8 shrink-0 items-center justify-center">
            <span className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-[var(--accent-dim)] bg-[var(--surface)] text-[var(--accent)]">
              <PlusIcon size={13} />
            </span>
          </span>
          <span className="py-1 text-left text-xs font-bold text-[var(--dim)]">
            {label}
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className="relative flex items-center gap-2 py-1">
      <span className="flex w-8 shrink-0 items-center justify-center">
        <button
          type="button"
          aria-label={label}
          aria-expanded={true}
          onClick={onToggle}
          className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--accent)] bg-[var(--surface)] text-[var(--accent)]"
        >
          <PlusIcon size={13} />
        </button>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-[var(--accent-dim)] bg-[#123c26] px-2.5 py-1.5 text-xs font-black text-[#4ade80]"
          onClick={() => onPick("walk")}
        >
          <WalkIcon size={13} /> 徒歩で{verb}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-[var(--accent-dim)] bg-[#123c26] px-2.5 py-1.5 text-xs font-black text-[#4ade80]"
          onClick={() => onPick("train")}
        >
          <TrainIcon size={13} /> 電車で{verb}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-[var(--accent-dim)] bg-[#123c26] px-2.5 py-1.5 text-xs font-black text-[#4ade80]"
          onClick={() => onPick("bus")}
        >
          <BusIcon size={13} /> バスで{verb}
        </button>
        <span className="text-xs text-[var(--dim)]">
          {verb === "つなぐ"
            ? "新しいスタート地点を選ぶ欄が先頭に追加されます"
            : "ここに新しい地点をはさみます"}
        </span>
      </span>
    </div>
  );
}

// One-line summary shown in a segment card's header, so the whole route
// reads as a chain of spots even before any card is examined in detail.
function segmentSummary(d: DraftSegment): string {
  const from = d.place.name || "（未定）";
  const to = d.toPlace.name || "（未定）";
  if (d.type === "origin") {
    return d.place.address || "経路のスタート地点";
  }
  if (d.type === "walk") {
    return `${from} → ${to}${d.baseWalkMin ? ` ・ 約${d.baseWalkMin}分` : ""}`;
  }
  return `${d.line ? `${d.line} ・ ` : ""}${from} → ${to}`;
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
  // Which insert strip is expanded: -1 = before the start, i = after
  // drafts[i], null = none.
  const [insertAt, setInsertAt] = useState<number | null>(null);
  // Key of the segment just inserted/prepended, ring-highlighted so the
  // user sees where the new card landed.
  const [highlightKey, setHighlightKey] = useState<number | null>(null);

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
  const draftForKind = (kind: SegmentKind): DraftSegment =>
    kind === "walk"
      ? newDraftSegment("walk")
      : newDraftSegment("ride", kind === "bus" ? "bus" : "train");

  const add = (kind: SegmentKind) => {
    const draft = draftForKind(kind);
    setHighlightKey(draft.key);
    setDrafts((prev) => {
      const last = prev[prev.length - 1];
      if (last) {
        // The new segment starts where the previous one ended — the user
        // only registers the new end point.
        const end = endPlaceOf(last);
        draft.place = { ...end };
        draft.fromLabel = end.name;
        if (draft.type === "ride" && draft.vehicle === "train" && end.line) {
          draft.line = end.line;
        }
      }
      return [...prev, draft];
    });
  };

  // Insert a new segment right after drafts[idx] (mid-route spot
  // insertion). The new segment starts at drafts[idx]'s end spot; the
  // segment that used to follow now starts at the NEW segment's end
  // spot, via rechain — so once the user registers the new spot, the
  // rest of the route re-links behind it automatically.
  const insertAfter = (idx: number, kind: SegmentKind) => {
    const draft = draftForKind(kind);
    setHighlightKey(draft.key);
    setDrafts((prev) => {
      const before = prev[idx];
      if (before) {
        const end = endPlaceOf(before);
        draft.place = { ...end };
        draft.fromLabel = end.name;
        if (draft.type === "ride" && draft.vehicle === "train" && end.line) {
          draft.line = end.line;
        }
      }
      const next = [
        ...prev.slice(0, idx + 1),
        draft,
        ...prev.slice(idx + 1),
      ];
      return rechain(next);
    });
    setInsertAt(null);
  };

  // Move the start one spot earlier: a fresh origin (the user picks the
  // new start spot in its picker) plus a connecting walk/ride segment
  // whose destination is the old start spot. The old origin card goes
  // away — its spot lives on as the connecting segment's end, and the
  // rest of the chain re-links behind it unchanged.
  const prepend = (kind: SegmentKind) => {
    const newOrigin = newDraftSegment("origin");
    const seg = draftForKind(kind);
    setHighlightKey(newOrigin.key);
    setDrafts((prev) => {
      const oldOrigin = prev[0];
      if (!oldOrigin) return prev;
      seg.toPlace = { ...oldOrigin.place };
      seg.toLabel = oldOrigin.place.name;
      if (seg.type === "ride" && seg.vehicle === "train" && oldOrigin.place.line) {
        seg.line = oldOrigin.place.line;
      }
      return rechain([newOrigin, seg, ...prev.slice(1)]);
    });
    setInsertAt(null);
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
        行き・帰りは分けず、1つの経路で登録します。どちらの方向かはアプリが現在地から自動で判定します。余裕は「ホームに着いてから発車まで」に確保する安全マージンです。途中に地点をはさみたいときは、区間の間にある「＋」からその場で追加できます。
      </p>

      <div className="relative mt-3">
        {/* Timeline rail behind the dots and insert buttons. */}
        <div
          aria-hidden
          className="absolute bottom-4 left-[15px] top-4 w-[2px] rounded bg-[var(--border)]"
        />
        <InsertStrip
          label="スタートの手前に地点を追加"
          verb="つなぐ"
          open={insertAt === -1}
          onToggle={() => setInsertAt(insertAt === -1 ? null : -1)}
          onPick={prepend}
        />
        {drafts.map((d, idx) => (
          <div key={d.key}>
            <div className="relative flex gap-2">
              <span className="flex w-8 shrink-0 justify-center pt-3">
                <span
                  className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border ${
                    d.type === "origin"
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[#0b2013]"
                      : "border-[var(--border)] bg-[var(--surface2)]"
                  }`}
                >
                  {d.type === "origin" ? (
                    <FlagIcon size={15} />
                  ) : d.type === "walk" ? (
                    <WalkIcon size={15} className="text-[var(--warn)]" />
                  ) : d.vehicle === "bus" ? (
                    <BusIcon size={15} className="text-[var(--accent)]" />
                  ) : (
                    <TrainIcon size={15} className="text-[var(--accent)]" />
                  )}
                </span>
              </span>
              <div
                className={`min-w-0 flex-1 rounded-lg border bg-[var(--surface2)] p-3 ${
                  d.key === highlightKey
                    ? "border-[var(--accent)] ring-2 ring-[var(--accent)]"
                    : "border-[var(--border)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-black">
                    {idx + 1}.{" "}
                    {d.type === "origin"
                      ? "出発地点"
                      : d.type === "walk"
                        ? "徒歩"
                        : d.vehicle === "bus"
                          ? "バス"
                          : "電車"}
                    {d.key === highlightKey && (
                      <span className="rounded bg-[#123c26] px-1.5 py-0.5 text-[11px] font-bold text-[#4ade80]">
                        追加しました
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
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
                <p className="mt-1 text-xs text-[var(--dim)]">
                  {segmentSummary(d)}
                </p>

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
                    <div>
                      <span className={labelCls}>乗り物</span>
                      <div
                        className="flex rounded-md border border-[var(--border)]"
                        role="group"
                        aria-label={`区間${idx + 1}の乗り物の種類`}
                      >
                        {(
                          [
                            ["train", "電車", TrainIcon],
                            ["bus", "バス", BusIcon],
                          ] as const
                        ).map(([v, label, Icon]) => (
                          <button
                            key={v}
                            type="button"
                            aria-pressed={d.vehicle === v}
                            onClick={() => update(d.key, { vehicle: v })}
                            className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-bold ${
                              d.vehicle === v
                                ? "bg-[var(--surface)] text-[var(--text)]"
                                : "text-[var(--dim)]"
                            }`}
                          >
                            <Icon size={14} />
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <ChainedStart
                      label={d.vehicle === "bus" ? "乗車バス停" : "乗車駅"}
                      value={d.place}
                    />
                    <LineStationPicker
                      vehicle={d.vehicle}
                      line={d.line}
                      onLineChange={(line) => update(d.key, { line })}
                      boarding={d.place}
                      value={d.toPlace}
                      onChange={(toPlace) => setEndPlace(idx, toPlace)}
                      fallback={
                        <PlacePicker
                          label={
                            d.vehicle === "bus" ? "降車バス停" : "降車駅・バス停"
                          }
                          namePlaceholder={
                            d.vehicle === "bus" ? "例: 四条烏丸" : "例: 池袋"
                          }
                          value={d.toPlace}
                          onChange={(toPlace) => setEndPlace(idx, toPlace)}
                          near={placeNear(d.place)}
                        />
                      }
                    />
                    <Field label="乗換・入場（分・任意）">
                      <input
                        aria-label="乗り換え入場分数（任意）"
                        className={inputCls}
                        type="number"
                        min={0}
                        max={60}
                        placeholder="なし"
                        value={d.accessMin}
                        onChange={(e) =>
                          update(d.key, { accessMin: e.target.value })
                        }
                      />
                    </Field>
                    <p className="text-xs text-[var(--dim)]">
                      乗換・入場は、改札やホームまでの移動に時間がかかる駅だけで入力してください。空欄なら「なし（0分）」で計算します。乗車時間は時刻表（運行図）から自動で求めるので入力は不要です。
                    </p>
                    <p className="text-xs text-[var(--dim)]">
                      {d.vehicle === "bus"
                        ? "発車時刻は登録不要です。発車案内を開いたときに、路線と乗車バス停・降車バス停から時刻表を自動で取得して使います。停留所・路線は行き・帰り両方向で共通です。路線図（停留所一覧）から降車バス停を選べるのは、GTFSデータリポジトリ（国土交通省）に収録されたバス路線のみです。収録されていないバス路線は、降車バス停を検索で登録してください（その場合、時刻表の自動取得は対象外です）。"
                        : "発車時刻は登録不要です。発車案内を開いたときに、路線と乗車駅・降車駅から時刻表を自動で取得して使います。駅・路線は行き・帰り両方向で共通です。降車駅は路線図（駅一覧）から選べます。バスに乗る区間は、上の「乗り物」でバスに切り替えてください。"}
                    </p>
                  </div>
                )}
              </div>
            </div>
            {idx < drafts.length - 1 && (
              <InsertStrip
                label={
                  idx === 0
                    ? "出発地点の直後に地点を追加"
                    : `区間${idx + 1}の後に地点を追加`
                }
                verb="入れる"
                open={insertAt === idx}
                onToggle={() => setInsertAt(insertAt === idx ? null : idx)}
                onPick={(type) => insertAfter(idx, type)}
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-2 pl-10">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm font-bold"
          onClick={() => add("walk")}
        >
          <PlusIcon size={15} /> 徒歩区間を最後に追加
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm font-bold"
          onClick={() => add("train")}
        >
          <PlusIcon size={15} /> 電車区間を最後に追加
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-sm font-bold"
          onClick={() => add("bus")}
        >
          <PlusIcon size={15} /> バス区間を最後に追加
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
