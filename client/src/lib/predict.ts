// Pure prediction + formatting logic for the departure board.
// All times are minutes-of-day in Asia/Tokyo; absolute values may
// exceed 1440 for next-day departures (rendered with a 翌 prefix).

export type DayType = "weekday" | "holiday";

export interface SegmentLike {
  id: number;
  type: "origin" | "walk" | "ride";
  fromLabel: string;
  toLabel: string;
  station: string | null;
  line: string | null;
  baseWalkMin: number | null;
  accessMin: number | null;
  rideMin: number | null;
  departuresWeekday: number[];
  departuresHoliday: number[];
  lat: number | null;
  lng: number | null;
  learnedWalkMin: number | null;
  walkSamples: number;
}

export interface RouteLike {
  id: number;
  name: string;
  bufferMin: number;
  segments: SegmentLike[];
}

export interface StatusLike {
  line: string;
  status: "normal" | "delayed" | "suspended" | "unknown";
  delayMin: number | null;
  manualDelayMin: number | null;
}

export function effectiveDelayMin(st: StatusLike | undefined): number {
  if (!st) return 0;
  if (st.manualDelayMin != null) return st.manualDelayMin;
  if (st.status === "normal") return 0;
  return st.delayMin ?? 0;
}

export function isSuspended(st: StatusLike | undefined): boolean {
  return st?.status === "suspended";
}

/** Effective walking minutes for a segment: learned pace wins. */
export function walkMinutes(seg: SegmentLike): number | null {
  if (seg.type !== "walk") return null;
  return seg.learnedWalkMin ?? seg.baseWalkMin;
}

export interface LegPlan {
  segmentId: number;
  kind: "walk" | "ride";
  label: string;
  walkMin: number | null;
  learned: boolean;
  line: string | null;
  fromStation: string;
  toStation: string;
  schedDepart: number | null;
  depart: number | null; // effective (delay applied), absolute minutes
  arrive: number | null; // effective arrival at alighting station
  delayMin: number;
  suspended: boolean;
}

export interface PlanOption {
  legs: LegPlan[];
  /** Effective departure of the first ride (absolute minutes). */
  boardAt: number;
  /** Scheduled departure of the first ride (absolute minutes). */
  boardAtSched: number;
  /** When the user must leave the start point (absolute minutes). */
  leaveBy: number;
  /** Final arrival at the destination (absolute minutes). */
  arriveAt: number;
  /** Minutes from the start point to the first platform (walks + access). */
  toPlatformMin: number;
  nextDay: boolean;
}

export interface PlanResult {
  options: PlanOption[];
  firstRideSegmentId: number | null;
  /** True when no departure remains today for the first ride. */
  endOfService: boolean;
  hasRide: boolean;
  missingWalk: boolean;
  firstRideSuspended: boolean;
}

function departuresFor(seg: SegmentLike, dayType: DayType): number[] {
  const list =
    dayType === "weekday" ? seg.departuresWeekday : seg.departuresHoliday;
  return [...list].sort((a, b) => a - b);
}

export function computePlans(
  route: RouteLike,
  dayType: DayType,
  statuses: Map<string, StatusLike>,
  nowMin: number,
  startIndex: number,
): PlanResult {
  const segs = route.segments;
  const empty: PlanResult = {
    options: [],
    firstRideSegmentId: null,
    endOfService: false,
    hasRide: segs.some((s) => s.type === "ride"),
    missingWalk: false,
    firstRideSuspended: false,
  };
  const firstRideIdx = segs.findIndex(
    (s, i) => i >= startIndex && s.type === "ride",
  );
  if (firstRideIdx === -1) return empty;
  const firstRide = segs[firstRideIdx];
  if (!firstRide) return empty;

  // Minutes from the start point to the first platform.
  let toPlatform = 0;
  let missingWalk = false;
  for (let i = startIndex; i < firstRideIdx; i++) {
    const seg = segs[i];
    if (seg && seg.type === "walk") {
      const w = walkMinutes(seg);
      if (w == null) missingWalk = true;
      toPlatform += w ?? 0;
    }
  }
  toPlatform += firstRide.accessMin ?? 0;

  const firstStatus = firstRide.line
    ? statuses.get(firstRide.line)
    : undefined;
  const firstDelay = effectiveDelayMin(firstStatus);
  const firstSuspended = isSuspended(firstStatus);
  const deps = departuresFor(firstRide, dayType);
  const need = nowMin + toPlatform + route.bufferMin;

  const walkLeg = (seg: SegmentLike): LegPlan => ({
    segmentId: seg.id,
    kind: "walk",
    label: `${seg.fromLabel} → ${seg.toLabel}`,
    walkMin: walkMinutes(seg),
    learned: seg.learnedWalkMin != null,
    line: null,
    fromStation: seg.fromLabel,
    toStation: seg.toLabel,
    schedDepart: null,
    depart: null,
    arrive: null,
    delayMin: 0,
    suspended: false,
  });

  /** Build a full itinerary whose first ride departs at firstSchedAbs
   * (absolute scheduled minutes; >=1440 means tomorrow). */
  const buildChain = (firstSchedAbs: number): PlanOption | null => {
    const legs: LegPlan[] = [];
    let cur = nowMin;
    for (let i = startIndex; i < firstRideIdx; i++) {
      const seg = segs[i];
      if (!seg || seg.type !== "walk") continue;
      legs.push(walkLeg(seg));
      cur += walkMinutes(seg) ?? 0;
    }
    let boardAt = 0;
    let boardAtSched = 0;
    let rideCount = 0;
    for (let i = firstRideIdx; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      if (seg.type === "walk") {
        legs.push(walkLeg(seg));
        cur += walkMinutes(seg) ?? 0;
        continue;
      }
      if (seg.type !== "ride") continue;
      const segStatus = seg.line ? statuses.get(seg.line) : undefined;
      const segDelay = effectiveDelayMin(segStatus);
      const segDeps = departuresFor(seg, dayType);
      let schedAbs: number | null = null;
      if (rideCount === 0) {
        schedAbs = firstSchedAbs;
      } else {
        const earliest = cur + (seg.accessMin ?? 0);
        for (const d of segDeps) {
          for (const dayOff of [0, 1440]) {
            if (d + dayOff + segDelay >= earliest) {
              schedAbs = d + dayOff;
              break;
            }
          }
          if (schedAbs != null) break;
        }
      }
      if (schedAbs == null) return null;
      const departAbs = schedAbs + segDelay;
      const arrive = departAbs + (seg.rideMin ?? 0);
      if (rideCount === 0) {
        boardAt = departAbs;
        boardAtSched = schedAbs;
      }
      rideCount += 1;
      legs.push({
        segmentId: seg.id,
        kind: "ride",
        label: `${seg.line ?? ""} ${seg.station ?? ""} → ${seg.toLabel}`,
        walkMin: null,
        learned: false,
        line: seg.line,
        fromStation: seg.station ?? seg.fromLabel,
        toStation: seg.toLabel,
        schedDepart: schedAbs,
        depart: departAbs,
        arrive,
        delayMin: segDelay,
        suspended: isSuspended(segStatus),
      });
      cur = arrive;
    }
    if (rideCount === 0) return null;
    return {
      legs,
      boardAt,
      boardAtSched,
      leaveBy: boardAt - toPlatform - route.bufferMin,
      arriveAt: cur,
      toPlatformMin: toPlatform,
      nextDay: firstSchedAbs >= 1440,
    };
  };

  const base: PlanResult = {
    ...empty,
    hasRide: true,
    firstRideSegmentId: firstRide.id,
    missingWalk,
    firstRideSuspended: firstSuspended,
  };
  if (firstSuspended) return base;

  const candidates = deps.filter((d) => d + firstDelay >= need).slice(0, 3);
  const options: PlanOption[] = [];
  for (const c of candidates) {
    const opt = buildChain(c);
    if (opt) options.push(opt);
  }
  if (options.length > 0) return { ...base, options };

  const first = deps[0];
  if (first != null) {
    const opt = buildChain(first + 1440);
    return { ...base, options: opt ? [opt] : [], endOfService: true };
  }
  return { ...base, endOfService: true };
}

/** Straight-line distance in meters (haversine). */
export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Format absolute minutes as H:MM; >=1440 gets a 翌 prefix. */
export function fmtTime(absMin: number): string {
  const total = Math.round(absMin);
  const nextDay = total >= 1440;
  const m = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${nextDay ? "翌" : ""}${h}:${String(mm).padStart(2, "0")}`;
}

/** Format a duration in seconds as M:SS or H:MM:SS. */
export function fmtCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Parse a timetable textarea into sorted unique minutes-of-day.
 * Accepts "7:02 7:12" pairs and grouped lines like "7: 02 12 22". */
export function parseTimes(text: string): number[] {
  const out = new Set<number>();
  for (const line of text.split(/\n/)) {
    const grouped = line.match(/^\s*(\d{1,2})[:：]\s*((?:\d{1,2}[\s,、]*)+)$/);
    if (grouped && grouped[1] && grouped[2]) {
      const hour = Number(grouped[1]);
      for (const tok of grouped[2].split(/[\s,、]+/).filter(Boolean)) {
        const min = Number(tok);
        if (min >= 0 && min < 60) out.add(hour * 60 + min);
      }
      continue;
    }
    const pairRe = /(\d{1,2})[:：](\d{2})/g;
    let match: RegExpExecArray | null;
    while ((match = pairRe.exec(line)) !== null) {
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h >= 0 && h < 27 && m < 60) out.add(h * 60 + m);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Format minutes-of-day as grouped timetable text: one "H: mm mm" line per hour. */
export function formatTimes(list: number[]): string {
  const byHour = new Map<number, number[]>();
  for (const t of [...list].sort((a, b) => a - b)) {
    const h = Math.floor(t / 60);
    const arr = byHour.get(h) ?? [];
    arr.push(t % 60);
    byHour.set(h, arr);
  }
  return [...byHour.entries()]
    .map(
      ([h, mins]) =>
        `${h}: ${mins.map((m) => String(m).padStart(2, "0")).join(" ")}`,
    )
    .join("\n");
}

/** Generate departures from first/last/interval (minutes-of-day). */
export function generateTimes(
  first: number,
  last: number,
  interval: number,
): number[] {
  if (interval <= 0 || last < first) return [];
  const out: number[] = [];
  for (let t = first; t <= last; t += interval) out.push(t);
  return out;
}

/** Current time in Asia/Tokyo. */
export function nowJst(): {
  minutesFloat: number;
  dayType: DayType;
  clockLabel: string;
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekday = get("weekday");
  return {
    minutesFloat: hour * 60 + minute + second / 60,
    dayType: weekday === "Sat" || weekday === "Sun" ? "holiday" : "weekday",
    clockLabel: `${hour}:${String(minute).padStart(2, "0")}`,
  };
}
