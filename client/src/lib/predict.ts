// Pure prediction + formatting logic for the departure board.
// All times are minutes-of-day in Asia/Tokyo; absolute values may
// exceed 1440 for next-day departures (rendered with a 翌 prefix).

export type DayType = "weekday" | "holiday";

export interface SegmentLike {
  id: number;
  position: number;
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
  placeName: string | null;
  placeAddress: string | null;
  toPlaceName: string | null;
  toPlaceAddress: string | null;
  toLat: number | null;
  toLng: number | null;
  returnWeekday: number[];
  returnHoliday: number[];
  learnedWalkMin: number | null;
  walkSamples: number;
  /** Per-train data (rail segments with an ekitan source only). */
  trainsWeekday?: RideTrain[];
  trainsHoliday?: RideTrain[];
  /** Mid-segment transfer options for this segment's trains. */
  transferOptions?: TransferOption[];
}

export interface RouteLike {
  id: number;
  name: string;
  bufferMin: number;
  segments: SegmentLike[];
}

export interface TimetableLike {
  line: string;
  station: string;
  toward: string;
  weekday: number[];
  holiday: number[];
}

/** One scheduled train of a ride segment, from the per-train
 * timetable (ekitan). arriveDest is the train's own arrival minute
 * at the segment's alighting station from its stop list, or null
 * when the detail was not fetched / the train does not stop there. */
export interface RideTrain {
  depart: number;
  type: string;
  dest: string;
  arriveDest: number | null;
  /** False when the train's stop list is known NOT to include the
   * alighting station (short workings, different branch); null when
   * the stop list has not been fetched. */
  servesDest?: boolean | null;
}

/** One stop of one train: station core + arrival/departure minutes. */
export interface TrainStopLike {
  station: string;
  arrive: number | null;
  depart: number | null;
}

/**
 * A mid-segment transfer: ride the boarded train to an intermediate
 * station, change onto a faster train of the same line/direction,
 * and reach the alighting station at arriveDest. All minutes-of-day.
 */
export interface TransferOption {
  /** Departure of the train boarded at the segment's start. */
  boardDepart: number;
  /** Type of the boarded train (e.g. 普通). */
  boardType: string;
  viaStation: string;
  /** Arrival of the boarded train at the transfer station. */
  localArriveVia: number;
  /** Departure of the faster train at the transfer station. */
  expressDepart: number;
  expressType: string;
  expressDest: string;
  /** Arrival of the faster train at the alighting station. */
  arriveDest: number;
}

/** Station name without the generic 駅 suffix, as used in cache keys. */
export function stationCore(name: string): string {
  return name.replace(/\s+/g, "").replace(/駅$/, "");
}

export function timetableKey(
  line: string,
  station: string,
  toward: string,
): string {
  return `${line}|${stationCore(station)}|${stationCore(toward)}`;
}

/**
 * Fill ride segments that carry no user-registered timetable with the
 * automatically fetched (cached) timetable for their line / boarding
 * station / direction. Segments with their own departures keep them.
 */
export function applyTimetables(
  route: RouteLike,
  timetables: TimetableLike[],
): RouteLike {
  if (timetables.length === 0) return route;
  const byKey = new Map(
    timetables.map((t) => [timetableKey(t.line, t.station, t.toward), t]),
  );
  let changed = false;
  const segments = route.segments.map((seg) => {
    if (seg.type !== "ride" || !seg.line) return seg;
    if (seg.departuresWeekday.length > 0) return seg;
    const tt = byKey.get(
      timetableKey(seg.line, seg.station ?? seg.fromLabel, seg.toLabel),
    );
    if (!tt || tt.weekday.length === 0) return seg;
    changed = true;
    return {
      ...seg,
      departuresWeekday: tt.weekday,
      departuresHoliday: tt.holiday.length > 0 ? tt.holiday : tt.weekday,
    };
  });
  return changed ? { ...route, segments } : route;
}

export interface TrainTimetableLike {
  line: string;
  station: string;
  toward: string;
  weekday: { depart: number; type: string; dest: string }[];
  holiday: { depart: number; type: string; dest: string }[];
}

/** Loose station-core equality (梅田 vs 大阪梅田), mirroring the
 * server's stationCoreLooseEq. */
export function stationCoreLooseEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (
    (short as string).length >= 2 && (long as string).endsWith(short as string)
  );
}

/** Detail-map key for one train's stop list. */
export function trainDetailKey(
  line: string,
  station: string,
  toward: string,
  dayType: DayType,
  depart: number,
): string {
  return `${timetableKey(line, station, toward)}|${dayType}|${depart}`;
}

/**
 * Merge per-train data into a route: ride segments whose line +
 * boarding station + direction have a fetched per-train timetable
 * gain train lists (type / destination per departure), with real
 * arrival minutes at the alighting station filled in from the
 * fetched train details. Departure minutes come from the same
 * trains, so the minutes model and the train model never diverge.
 */
export function applyTrainData(
  route: RouteLike,
  trainTimetables: TrainTimetableLike[],
  details: Map<string, TrainStopLike[]>,
): RouteLike {
  if (trainTimetables.length === 0) return route;
  const byKey = new Map(
    trainTimetables.map((t) => [
      timetableKey(t.line, t.station, t.toward),
      t,
    ]),
  );
  let changed = false;
  const segments = route.segments.map((seg) => {
    if (seg.type !== "ride" || !seg.line) return seg;
    const station = seg.station ?? seg.fromLabel;
    const tt = byKey.get(timetableKey(seg.line, station, seg.toLabel));
    if (!tt || tt.weekday.length === 0) return seg;
    const destCore = stationCore(seg.toLabel);
    const build = (
      list: { depart: number; type: string; dest: string }[],
      dayType: DayType,
    ): RideTrain[] =>
      list.map((t) => {
        const stops = details.get(
          trainDetailKey(seg.line as string, station, seg.toLabel, dayType, t.depart),
        );
        if (!stops) {
          return { ...t, arriveDest: null, servesDest: null };
        }
        const stop = stops.find((s) =>
          stationCoreLooseEq(stationCore(s.station), destCore),
        );
        if (!stop) return { ...t, arriveDest: null, servesDest: false };
        return {
          ...t,
          arriveDest: stop.arrive ?? stop.depart,
          servesDest: true,
        };
      });
    changed = true;
    return {
      ...seg,
      departuresWeekday: tt.weekday.map((t) => t.depart),
      departuresHoliday: (tt.holiday.length > 0 ? tt.holiday : tt.weekday).map(
        (t) => t.depart,
      ),
      trainsWeekday: build(tt.weekday, "weekday"),
      trainsHoliday: build(
        tt.holiday.length > 0 ? tt.holiday : tt.weekday,
        "holiday",
      ),
    };
  });
  return changed ? { ...route, segments } : route;
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
  /** Transfer wait before this ride: depart − previous ride's arrival
   * − this segment's access minutes. Null for walks and the first ride. */
  waitMin: number | null;
  /** Train type of the ridden train (特急/快速/普通…), when per-train
   * data is available for this segment. */
  trainType: string | null;
  /** Destination of the ridden train, when known. */
  trainDest: string | null;
  /** Mid-segment transfer actually used: alight at viaStation from
   * the boarded train and continue on a faster train. Times are
   * effective (delay applied) absolute minutes. */
  transferWithin: {
    viaStation: string;
    localArriveVia: number;
    expressDepart: number;
    expressType: string;
    expressDest: string;
  } | null;
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
  /** Sum of transfer waits between rides (access minutes excluded). */
  totalWaitMin: number;
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

/** How the first ride's mid-segment transfer choice is resolved:
 * "auto" = fastest arrival (use a transfer when it arrives earlier),
 * "stay" = ride the boarded train through, "transfer" = use the best
 * mid-segment transfer of the boarded train. */
export type FirstRideMode = "auto" | "stay" | "transfer";

export interface PlanConstraint {
  /** Minutes-of-day departure the first ride must board. */
  firstDepart?: number;
  firstMode?: FirstRideMode;
}

function trainsFor(seg: SegmentLike, dayType: DayType): RideTrain[] {
  const list =
    dayType === "weekday" ? seg.trainsWeekday : seg.trainsHoliday;
  return [...(list ?? [])].sort((a, b) => a.depart - b.depart);
}

interface RidePick {
  /** Scheduled departure, absolute minutes (may exceed 1440). */
  schedAbs: number;
  /** Scheduled arrival at the alighting station, absolute minutes. */
  arriveSchedAbs: number;
  train: RideTrain | null;
  transfer: TransferOption | null;
}

export function computePlans(
  route: RouteLike,
  dayType: DayType,
  statuses: Map<string, StatusLike>,
  nowMin: number,
  startIndex: number,
  constraint?: PlanConstraint,
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
    waitMin: null,
    trainType: null,
    trainDest: null,
    transferWithin: null,
  });

  /** Best arrival (minutes-of-day) at the alighting station for one
   * train of a segment, optionally via its mid-segment transfers. */
  const bestForTrain = (
    seg: SegmentLike,
    train: RideTrain,
    mode: FirstRideMode,
  ): { arrive: number; transfer: TransferOption | null } => {
    const direct = train.arriveDest ?? train.depart + (seg.rideMin ?? 0);
    if (mode === "stay") return { arrive: direct, transfer: null };
    const options = (seg.transferOptions ?? []).filter(
      (o) => o.boardDepart === train.depart,
    );
    if (options.length === 0) return { arrive: direct, transfer: null };
    let bestOpt: TransferOption | null = null;
    for (const o of options) {
      if (!bestOpt || o.arriveDest < bestOpt.arriveDest) bestOpt = o;
    }
    if (mode === "transfer") {
      return bestOpt
        ? { arrive: bestOpt.arriveDest, transfer: bestOpt }
        : { arrive: direct, transfer: null };
    }
    // auto: a transfer only counts when it actually arrives earlier.
    return bestOpt && bestOpt.arriveDest < direct
      ? { arrive: bestOpt.arriveDest, transfer: bestOpt }
      : { arrive: direct, transfer: null };
  };

  /**
   * Pick which train to ride on one segment. With per-train data the
   * pick minimizes the ARRIVAL at the alighting station (a later
   * express can beat an earlier local; a mid-segment transfer counts
   * in "auto"/"transfer" modes). Without per-train data this is the
   * earliest catchable departure, as before.
   */
  const pickRide = (
    seg: SegmentLike,
    earliest: number,
    delay: number,
    fixed?: { departMod: number; mode: FirstRideMode; dayOffset: number },
  ): RidePick | null => {
    const trains = trainsFor(seg, dayType).filter(
      (t) => t.servesDest !== false,
    );
    if (trains.length === 0) {
      // Minutes-only model.
      const segDeps = departuresFor(seg, dayType);
      let schedAbs: number | null = null;
      if (fixed) {
        schedAbs = fixed.departMod + fixed.dayOffset;
      } else {
        for (const d of segDeps) {
          if (d + delay >= earliest) {
            schedAbs = d;
            break;
          }
        }
        if (schedAbs == null) {
          const firstDep = segDeps[0];
          if (firstDep != null) schedAbs = firstDep + 1440;
        }
      }
      if (schedAbs == null) return null;
      return {
        schedAbs,
        arriveSchedAbs: schedAbs + (seg.rideMin ?? 0),
        train: null,
        transfer: null,
      };
    }
    if (fixed) {
      const train =
        trains.find((t) => t.depart === fixed.departMod) ??
        trainsFor(seg, dayType).find((t) => t.depart === fixed.departMod);
      if (!train) return null;
      const best = bestForTrain(seg, train, fixed.mode);
      return {
        schedAbs: train.depart + fixed.dayOffset,
        arriveSchedAbs: best.arrive + fixed.dayOffset,
        train,
        transfer: best.transfer,
      };
    }
    let best: RidePick | null = null;
    for (const train of trains) {
      if (train.depart + delay < earliest) continue;
      if (best && train.depart > earliest + 180) break;
      const b = bestForTrain(seg, train, "auto");
      const cand: RidePick = {
        schedAbs: train.depart,
        arriveSchedAbs: b.arrive,
        train,
        transfer: b.transfer,
      };
      if (
        !best ||
        cand.arriveSchedAbs < best.arriveSchedAbs ||
        (cand.arriveSchedAbs === best.arriveSchedAbs &&
          cand.schedAbs < best.schedAbs)
      ) {
        best = cand;
      }
      // Once a train departing at/after the best arrival is reached,
      // nothing later can arrive earlier on the same segment.
      if (best && train.depart >= best.arriveSchedAbs) break;
    }
    if (best) return best;
    const firstTrain = trains[0];
    if (!firstTrain) return null;
    const b = bestForTrain(seg, firstTrain, "auto");
    return {
      schedAbs: firstTrain.depart + 1440,
      arriveSchedAbs: b.arrive + 1440,
      train: firstTrain,
      transfer: b.transfer,
    };
  };

  /** Build a full itinerary whose first ride departs at firstSchedAbs
   * (absolute scheduled minutes; >=1440 means tomorrow). */
  const buildChain = (
    firstSchedAbs: number,
    firstMode: FirstRideMode = "auto",
  ): PlanOption | null => {
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
    let prevRideArrive: number | null = null;
    let totalWaitMin = 0;
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
      // Earliest catchable departure TODAY; only when none remains
      // does the chain continue on tomorrow's first departure.
      // (Checking [today, tomorrow] per departure and taking the
      // first hit is wrong: for an early-morning departure that has
      // already left, its tomorrow instance always "matches", so
      // the chain jumps to tomorrow even in the middle of the day —
      // this once produced a 505-minute "wait" at なんば at 20:52.)
      const pick =
        rideCount === 0
          ? pickRide(seg, Number.NEGATIVE_INFINITY, segDelay, {
              departMod: ((firstSchedAbs % 1440) + 1440) % 1440,
              mode: firstMode,
              dayOffset: firstSchedAbs >= 1440 ? 1440 : 0,
            })
          : pickRide(seg, cur + (seg.accessMin ?? 0), segDelay, undefined);
      if (!pick) return null;
      const schedAbs = pick.schedAbs;
      const departAbs = schedAbs + segDelay;
      const arrive = pick.arriveSchedAbs + segDelay;
      const waitMin =
        rideCount > 0 && prevRideArrive != null
          ? Math.max(
              0,
              Math.round(departAbs - prevRideArrive - (seg.accessMin ?? 0)),
            )
          : null;
      if (waitMin != null) totalWaitMin += waitMin;
      if (rideCount === 0) {
        boardAt = departAbs;
        boardAtSched = schedAbs;
      }
      rideCount += 1;
      const dayOffset = schedAbs >= 1440 ? 1440 : 0;
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
        waitMin,
        trainType: pick.train?.type ?? null,
        trainDest: pick.train?.dest ?? null,
        transferWithin: pick.transfer
          ? {
              viaStation: pick.transfer.viaStation,
              localArriveVia: pick.transfer.localArriveVia + dayOffset + segDelay,
              expressDepart: pick.transfer.expressDepart + dayOffset + segDelay,
              expressType: pick.transfer.expressType,
              expressDest: pick.transfer.expressDest,
            }
          : null,
      });
      prevRideArrive = arrive;
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
      totalWaitMin,
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

  // A fixed first-train choice (the focus tabs): board exactly this
  // departure, with the requested mid-segment transfer behaviour.
  if (constraint?.firstDepart != null) {
    const dep = constraint.firstDepart;
    const abs = dep + firstDelay >= need ? dep : dep + 1440;
    const opt = buildChain(abs, constraint.firstMode ?? "auto");
    return { ...base, options: opt ? [opt] : [], endOfService: abs >= 1440 };
  }

  const firstTrains = trainsFor(firstRide, dayType).filter(
    (t) => t.servesDest !== false,
  );
  const candidates =
    firstTrains.length > 0
      ? firstTrains
          .map((t) => t.depart)
          .filter((d) => d + firstDelay >= need)
          .slice(0, 3)
      : deps.filter((d) => d + firstDelay >= need).slice(0, 3);
  const options: PlanOption[] = [];
  for (const c of candidates) {
    const opt = buildChain(c);
    if (opt) options.push(opt);
  }
  if (options.length > 0) return { ...base, options };

  const first = firstTrains.length > 0 ? firstTrains[0]?.depart : deps[0];
  if (first != null) {
    const opt = buildChain(first + 1440);
    return { ...base, options: opt ? [opt] : [], endOfService: true };
  }
  return { ...base, endOfService: true };
}

export interface FocusChoice {
  id: string;
  /** Departure (minutes-of-day) boarded at the first ride segment. */
  boardDepart: number;
  /** How many trains later than the first catchable one (0 = first). */
  laterBy: number;
  /** Train type of the boarded train, when per-train data exists. */
  boardType: string | null;
  boardDest: string | null;
  /** The mid-segment transfer behaviour of this choice. */
  mode: "stay" | "transfer" | "direct";
  /** Transfer station when mode === "transfer". */
  viaStation: string | null;
  expressType: string | null;
  plan: PlanOption;
}

/**
 * The choices the user actually faces at the first boarding point,
 * per the requested interaction: focus on the trains connectable
 * from this moment; at a mid-segment transfer opportunity choose
 * 乗り換える (change onto the faster train) or 乗り換えない (stay
 * through, keep the seat); departing one train later gets the same
 * treatment. Every choice is a full re-simulation to the final
 * arrival, so how the downstream catchable trains change is visible
 * in each choice's plan legs.
 */
export function computeFocusChoices(
  route: RouteLike,
  dayType: DayType,
  statuses: Map<string, StatusLike>,
  nowMin: number,
  startIndex: number,
): FocusChoice[] {
  const segs = route.segments;
  const firstRideIdx = segs.findIndex(
    (s, i) => i >= startIndex && s.type === "ride",
  );
  const firstRide = firstRideIdx >= 0 ? segs[firstRideIdx] : undefined;
  if (!firstRide) return [];
  const firstStatus = firstRide.line
    ? statuses.get(firstRide.line)
    : undefined;
  if (isSuspended(firstStatus)) return [];
  const firstDelay = effectiveDelayMin(firstStatus);
  let toPlatform = 0;
  for (let i = startIndex; i < firstRideIdx; i++) {
    const seg = segs[i];
    if (seg && seg.type === "walk") toPlatform += walkMinutes(seg) ?? 0;
  }
  toPlatform += firstRide.accessMin ?? 0;
  const need = nowMin + toPlatform + route.bufferMin;

  const trains = trainsFor(firstRide, dayType).filter(
    (t) => t.servesDest !== false,
  );
  const boardList: { depart: number; type: string | null; dest: string | null }[] =
    trains.length > 0
      ? trains
          .filter((t) => t.depart + firstDelay >= need)
          .slice(0, 3)
          .map((t) => ({ depart: t.depart, type: t.type, dest: t.dest }))
      : departuresFor(firstRide, dayType)
          .filter((d) => d + firstDelay >= need)
          .slice(0, 3)
          .map((d) => ({ depart: d, type: null, dest: null }));

  const out: FocusChoice[] = [];
  boardList.forEach((b, idx) => {
    const options = (firstRide.transferOptions ?? []).filter(
      (o) => o.boardDepart === b.depart,
    );
    const directArrive =
      trains.find((t) => t.depart === b.depart)?.arriveDest ??
      b.depart + (firstRide.rideMin ?? 0);
    const useful = options.filter((o) => o.arriveDest < directArrive);
    const variants: {
      mode: "stay" | "transfer" | "direct";
      viaStation: string | null;
      expressType: string | null;
    }[] =
      useful.length > 0
        ? [
            {
              mode: "transfer",
              viaStation: useful.reduce((a, c) =>
                c.arriveDest < a.arriveDest ? c : a,
              ).viaStation,
              expressType: useful.reduce((a, c) =>
                c.arriveDest < a.arriveDest ? c : a,
              ).expressType,
            },
            { mode: "stay", viaStation: null, expressType: null },
          ]
        : [{ mode: "direct", viaStation: null, expressType: null }];
    for (const v of variants) {
      const plan = computePlans(route, dayType, statuses, nowMin, startIndex, {
        firstDepart: b.depart,
        firstMode: v.mode === "direct" ? "stay" : v.mode,
      }).options[0];
      if (!plan) continue;
      out.push({
        id: `focus-${b.depart}-${v.mode}`,
        boardDepart: b.depart,
        laterBy: idx,
        boardType: b.type,
        boardDest: b.dest,
        mode: v.mode,
        viaStation: v.viaStation,
        expressType: v.expressType,
        plan,
      });
    }
  });
  return out;
}

export interface Scenario {
  id: string;
  /** Short label, e.g. 最短 / なんばで1本見送る. */
  label: string;
  /** What choice defines this scenario. */
  description: string;
  plan: PlanOption;
  /** Ride segment whose departure choice differs; null for the baseline. */
  skipSegmentId: number | null;
}

/**
 * Compare complete traversals of the route from the current position:
 * the fastest chain (board the earliest catchable train at every
 * station) against variants that pass up ONE departure at a single
 * boarding point and re-simulate everything downstream from there.
 * That is what makes the classic trade-off visible: a locally faster
 * connection that strands you at the last transfer shows a long final
 * wait and the same (or worse) arrival, while passing up a train
 * early can keep the same final arrival with less rushing.
 *
 * Implementation: each variant re-runs computePlans on a copy of the
 * route with the baseline's caught departure removed from that one
 * segment's list, so the engine itself stays the single source of
 * truth for chaining, delays and walking times.
 */
export function computeScenarios(
  route: RouteLike,
  dayType: DayType,
  statuses: Map<string, StatusLike>,
  nowMin: number,
  startIndex: number,
): Scenario[] {
  const base = computePlans(route, dayType, statuses, nowMin, startIndex);
  const baseline = base.options[0];
  if (!baseline || base.firstRideSuspended) return [];
  const out: Scenario[] = [
    {
      id: "fastest",
      label: "最短（乗れる電車にすぐ乗り継ぐ）",
      description: "各駅で最初に乗れる電車に乗り継いだ場合",
      plan: baseline,
      skipSegmentId: null,
    },
  ];
  const signature = (p: PlanOption): string =>
    p.legs
      .filter((l) => l.kind === "ride")
      .map((l) => `${l.segmentId}:${l.depart}`)
      .join("|") + `@${p.arriveAt}`;
  const seen = new Set([signature(baseline)]);
  for (const leg of baseline.legs) {
    if (out.length >= 5) break;
    if (leg.kind !== "ride" || leg.schedDepart == null) continue;
    const seg = route.segments.find((s) => s.id === leg.segmentId);
    if (!seg) continue;
    const depMin = ((leg.schedDepart % 1440) + 1440) % 1440;
    const variantRoute: RouteLike = {
      ...route,
      segments: route.segments.map((s) => {
        if (s.id !== seg.id) return s;
        const base =
          dayType === "weekday"
            ? {
                ...s,
                departuresWeekday: s.departuresWeekday.filter(
                  (d) => d !== depMin,
                ),
                trainsWeekday: (s.trainsWeekday ?? []).filter(
                  (t) => t.depart !== depMin,
                ),
              }
            : {
                ...s,
                departuresHoliday: s.departuresHoliday.filter(
                  (d) => d !== depMin,
                ),
                trainsHoliday: (s.trainsHoliday ?? []).filter(
                  (t) => t.depart !== depMin,
                ),
              };
        return {
          ...base,
          transferOptions: (s.transferOptions ?? []).filter(
            (o) => o.boardDepart !== depMin,
          ),
        };
      }),
    };
    const variant = computePlans(variantRoute, dayType, statuses, nowMin, startIndex)
      .options[0];
    if (!variant) continue;
    const sig = signature(variant);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const station = leg.fromStation;
    const stationLabel = station.endsWith("駅") ? station : `${station}駅`;
    out.push({
      id: `skip-${seg.id}`,
      label: `${station}で1本見送る`,
      description: `${leg.line ?? ""} ${stationLabel}で ${fmtTime(leg.schedDepart)}発を見送り、次に乗った場合`,
      plan: variant,
      skipSegmentId: seg.id,
    });
  }
  return out;
}

export type Direction = "outbound" | "return";

/** Ordered named points of a route (start → destination), for GPS work. */
export interface RoutePoint {
  label: string;
  lat: number;
  lng: number;
}

export function routePoints(route: RouteLike): RoutePoint[] {
  const pts: RoutePoint[] = [];
  const push = (label: string, lat: number | null, lng: number | null) => {
    if (lat == null || lng == null) return;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.lat - lat) < 1e-9 && Math.abs(last.lng - lng) < 1e-9) {
      return;
    }
    pts.push({ label, lat, lng });
  };
  for (const seg of route.segments) {
    if (seg.type === "origin") {
      push(seg.placeName ?? seg.toLabel, seg.lat, seg.lng);
    } else if (seg.type === "walk") {
      push(seg.placeName ?? seg.fromLabel, seg.lat, seg.lng);
      push(seg.toPlaceName ?? seg.toLabel, seg.toLat, seg.toLng);
    } else {
      push(seg.placeName ?? seg.station ?? seg.fromLabel, seg.lat, seg.lng);
      push(seg.toPlaceName ?? seg.toLabel, seg.toLat, seg.toLng);
    }
  }
  return pts;
}

/** Distance from a point to the route polyline, in meters (rough). */
function distToRouteM(
  pos: { lat: number; lng: number },
  pts: RoutePoint[],
): number {
  if (pts.length === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  const segDist = (
    p: { lat: number; lng: number },
    a: RoutePoint,
    b: RoutePoint,
  ): number => {
    const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const ax = a.lng * Math.cos(midLat);
    const ay = a.lat;
    const bx = b.lng * Math.cos(midLat);
    const by = b.lat;
    const px = p.lng * Math.cos(midLat);
    const py = p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return haversineM(p, { lat: cy, lng: cx / Math.cos(midLat) });
  };
  if (pts.length === 1) {
    const only = pts[0];
    return only ? haversineM(pos, only) : best;
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a && b) best = Math.min(best, segDist(pos, a, b));
  }
  return best;
}

/**
 * Auto-detect travel direction on a bidirectional route.
 * Uses where the user is relative to the two ends, confirmed/refined by
 * how they are moving along the route. Returns null when there is not
 * enough signal (no registered places, or the user is far from the route).
 */
export function detectDirection(
  route: RouteLike,
  prev: { lat: number; lng: number } | null,
  cur: { lat: number; lng: number },
): { direction: Direction; reason: string } | null {
  const pts = routePoints(route);
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return null;
  if (distToRouteM(cur, pts) > 3000) return null;

  const movedM = prev ? haversineM(prev, cur) : 0;
  if (prev && movedM >= 25) {
    const dFirstPrev = haversineM(prev, first);
    const dFirstCur = haversineM(cur, first);
    const dLastPrev = haversineM(prev, last);
    const dLastCur = haversineM(cur, last);
    const towardLast = dLastPrev - dLastCur;
    const towardFirst = dFirstPrev - dFirstCur;
    if (towardLast > 15 && towardLast >= towardFirst) {
      return {
        direction: "outbound",
        reason: `移動方向から「${last.label}」方面へ進んでいると判定`,
      };
    }
    if (towardFirst > 15 && towardFirst > towardLast) {
      return {
        direction: "return",
        reason: `移動方向から「${first.label}」方面へ進んでいると判定`,
      };
    }
  }

  const dFirst = haversineM(cur, first);
  const dLast = haversineM(cur, last);
  const NEAR_M = 800;
  if (dFirst <= NEAR_M && dLast > NEAR_M) {
    return {
      direction: "outbound",
      reason: `現在地が「${first.label}」付近のため行きと判定`,
    };
  }
  if (dLast <= NEAR_M && dFirst > NEAR_M) {
    return {
      direction: "return",
      reason: `現在地が「${last.label}」付近のため帰りと判定`,
    };
  }
  return null;
}

/**
 * Build the reversed view of a bidirectional route (the return trip).
 * Segment ids are preserved so walking-pace learning applies both ways.
 */
export function reversedRoute(route: RouteLike): RouteLike {
  const segs = route.segments;
  const lastSeg = segs[segs.length - 1];
  const originSeg = segs[0];
  if (!lastSeg || !originSeg || segs.length < 2) return route;
  const out: SegmentLike[] = [];
  out.push({
    ...originSeg,
    type: "origin",
    fromLabel: "",
    toLabel: lastSeg.toPlaceName ?? lastSeg.toLabel,
    lat: lastSeg.toLat ?? null,
    lng: lastSeg.toLng ?? null,
    placeName: lastSeg.toPlaceName ?? null,
    placeAddress: lastSeg.toPlaceAddress ?? null,
    toPlaceName: null,
    toPlaceAddress: null,
    toLat: null,
    toLng: null,
  });
  for (let i = segs.length - 1; i >= 1; i--) {
    const seg = segs[i];
    if (!seg) continue;
    if (seg.type === "walk") {
      out.push({
        ...seg,
        fromLabel: seg.toLabel,
        toLabel: seg.fromLabel,
        lat: seg.toLat ?? null,
        lng: seg.toLng ?? null,
        placeName: seg.toPlaceName ?? null,
        placeAddress: seg.toPlaceAddress ?? null,
        toPlaceName: seg.placeName ?? null,
        toPlaceAddress: seg.placeAddress ?? null,
        toLat: seg.lat ?? null,
        toLng: seg.lng ?? null,
      });
    } else if (seg.type === "ride") {
      out.push({
        ...seg,
        // Per-train data is direction-specific: the return view
        // fetches its own trains for the reversed station pair.
        trainsWeekday: undefined,
        trainsHoliday: undefined,
        transferOptions: undefined,
        fromLabel: seg.toLabel,
        toLabel: seg.station ?? seg.fromLabel,
        station: seg.toLabel,
        departuresWeekday:
          seg.returnWeekday.length > 0
            ? seg.returnWeekday
            : seg.departuresWeekday,
        departuresHoliday:
          seg.returnHoliday.length > 0
            ? seg.returnHoliday
            : seg.departuresHoliday,
        lat: seg.toLat ?? null,
        lng: seg.toLng ?? null,
        placeName: seg.toPlaceName ?? null,
        placeAddress: seg.toPlaceAddress ?? null,
        toPlaceName: seg.placeName ?? null,
        toPlaceAddress: seg.placeAddress ?? null,
        toLat: seg.lat ?? null,
        toLng: seg.lng ?? null,
      });
    }
  }
  return { ...route, segments: out };
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
