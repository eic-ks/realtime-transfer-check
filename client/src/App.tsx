import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
applyTimetables,
applyTrainData,
computeFocusChoices,
computePlans,
computeScenarios,
detectDirection,
effectiveDelayMin,
fmtCountdown,
fmtTime,
haversineM,
nowJst,
reversedRoute,
routePoints,
stationCore,
stationCoreLooseEq,
timetableKey,
trainDetailKey,
walkMinutes,
type DayType,
type Direction,
type PlanOption,
type RouteLike,
type TrainStopLike,
type TransferOption,
} from "./lib/predict";
import {
RouteEditor,
newDraftSegment,
routeToDraft,
type DraftSegment,
type RoutePayload,
} from "./components/RouteEditor";
import {
AlertIcon,
ClockIcon,
CrosshairIcon,
PinIcon,
RefreshIcon,
TrainIcon,
TrashIcon,
WalkIcon,
} from "./components/icons";

type State = ApiResponse<typeof api, "getState">;
type Route = State["routes"][number];
type Segment = Route["segments"][number];
type LineStatusRow = State["lineStatuses"][number];

type View = "board" | "routes" | "learn";

/** Ekitan cache rows fetched before this instant predate the
 * 2026-11-10 parser fix (operator line names + per-direction block
 * isolation) and are refetched once when the board opens. */
const TIMETABLE_FIX_EPOCH_MS = Date.parse("2026-11-10T11:00:00.000Z");

/** Station names picked from place search often already end in 駅
 * (なんば駅); append the suffix only when it is missing. */
const stationLabel = (name: string): string =>
  name.endsWith("駅") ? name : `${name}駅`;

const STATUS_META: Record<
  LineStatusRow["status"],
  { label: string; cls: string }
> = {
  normal: { label: "平常運転", cls: "bg-[#123c26] text-[#4ade80]" },
  delayed: { label: "遅延", cls: "bg-[#3d2c07] text-[#fbbf24]" },
  suspended: { label: "運転見合わせ", cls: "bg-[#3d1114] text-[#f87171]" },
  unknown: { label: "情報未取得", cls: "bg-[var(--surface2)] text-[var(--dim)]" },
};

function minutesAgo(iso: string | null): string {
  if (!iso) return "未取得";
  const diff = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return "たった今取得";
  if (diff < 60) return `${Math.floor(diff)}分前に取得`;
  return `${Math.floor(diff / 60)}時間前に取得`;
}

export function App() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  const [view, setView] = useState<View>("board");
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["state"] });

  const setActiveMut = useMutation({
    mutationFn: (id: number) => api.setActiveRoute({ id }),
    onSuccess: invalidate,
  });
  const setDirectionMut = useMutation({
    mutationFn: (args: { direction: Direction; source: "gps" | "manual" }) =>
      api.setDirection(args),
    onSuccess: invalidate,
  });
  const clearDirectionMut = useMutation({
    mutationFn: () => api.clearDirection({}),
    onSuccess: invalidate,
  });
  const deleteRouteMut = useMutation({
    mutationFn: (id: number) => api.deleteRoute({ id }),
    onSuccess: invalidate,
  });
  const saveRouteMut = useMutation({
    mutationFn: (args: { id: number | null } & RoutePayload) =>
      api.saveRoute(args),
    onSuccess: invalidate,
  });
  const recordWalkMut = useMutation({
    mutationFn: (args: { segmentId: number; plannedMin: number; actualMin: number }) =>
      api.recordWalk(args),
    onSuccess: invalidate,
  });
  const deleteLogMut = useMutation({
    mutationFn: (id: number) => api.deleteWalkLog({ id }),
    onSuccess: invalidate,
  });
  const manualDelayMut = useMutation({
    mutationFn: (args: { line: string; delayMin: number | null }) =>
      api.setManualDelay(args),
    onSuccess: invalidate,
  });
  const fetchTimetableMut = useMutation({
    mutationFn: (args: { line: string; station: string; toward: string }) =>
      api.fetchTimetable(args),
    onSuccess: invalidate,
  });
  const fetchTrainTimetableMut = useMutation({
    mutationFn: (args: { line: string; station: string; toward: string }) =>
      api.fetchTrainTimetable(args),
    onSuccess: invalidate,
  });
  const fetchTrainDetailsMut = useMutation({
    mutationFn: (args: {
      line: string;
      station: string;
      toward: string;
      dayType: DayType;
      departs: number[];
    }) => api.fetchTrainDetails(args),
  });

  const [refreshingLine, setRefreshingLine] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<{
    line: string;
    ok: boolean;
    message: string;
  } | null>(null);
  const refreshMut = useMutation({
    mutationFn: (line: string) => api.refreshLineStatus({ line }),
    onMutate: (line) => setRefreshingLine(line),
    onSettled: () => setRefreshingLine(null),
    onSuccess: (res, line) => {
      if (!res.ok) {
        setRefreshNote({
          line,
          ok: false,
          message: res.message ?? "取得できませんでした",
        });
      } else {
        setRefreshNote({ line, ok: true, message: "最新の運行情報を取得しました" });
      }
      invalidate();
    },
    onError: (_e, line) =>
      setRefreshNote({ line, ok: false, message: "取得に失敗しました" }),
  });

  const data = state.data;
  const activeRoute: Route | null = useMemo(() => {
    if (!data) return null;
    return (
      data.routes.find((r) => r.id === data.activeRouteId) ??
      data.routes[0] ??
      null
    );
  }, [data]);

  // Auto-refresh stale line statuses for the active route (once per line
  // per session; the user can always tap 更新）.
  const attemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeRoute) return;
    const lines = [
      ...new Set(
        activeRoute.segments
          .filter((s) => s.type === "ride" && s.line)
          .map((s) => s.line as string),
      ),
    ];
    for (const line of lines) {
      if (attemptedRef.current.has(line)) continue;
      const st = data?.lineStatuses.find((x) => x.line === line);
      const stale =
        !st?.fetchedAt ||
        Date.now() - new Date(st.fetchedAt).getTime() > 10 * 60 * 1000;
      if (stale) {
        attemptedRef.current.add(line);
        refreshMut.mutate(line);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute?.id, data?.lineStatuses.length]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <div className="mx-auto w-full max-w-2xl px-4 pb-10">
        <nav
          aria-label="表示切替"
          className="sticky top-0 z-10 -mx-4 bg-[var(--bg)] px-4 pb-2 pt-3"
        >
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1">
            {(
              [
                ["board", "発車案内"],
                ["routes", "経路"],
                ["learn", "歩行学習"],
              ] as [View, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`rounded-md py-2 text-sm font-black ${
                  view === v
                    ? "bg-[var(--accent)] text-[#0b2013]"
                    : "text-[var(--dim)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>

        {state.isPending && (
          <p className="py-16 text-center text-sm text-[var(--dim)]">読み込み中…</p>
        )}
        {state.error && (
          <p className="py-16 text-center text-sm text-[var(--danger)]">
            データの読み込みに失敗しました
          </p>
        )}
        {data && view === "board" && (
          <BoardView
            data={data}
            activeRoute={activeRoute}
            direction={data.direction}
            directionSource={data.directionSource}
            onDirection={(direction, source) =>
              setDirectionMut.mutate({ direction, source })
            }
            onClearDirection={() => clearDirectionMut.mutate()}
            onSelectRoute={(id) => setActiveMut.mutate(id)}
            refreshingLine={refreshingLine}
            refreshNote={refreshNote}
            onRefreshLine={(line) => refreshMut.mutate(line)}
            onManualDelay={(line, delayMin) =>
              manualDelayMut.mutate({ line, delayMin })
            }
            onFetchTimetable={(line, station, toward) =>
              fetchTimetableMut.mutateAsync({ line, station, toward })
            }
            onFetchTrainTimetable={(line, station, toward) =>
              fetchTrainTimetableMut.mutateAsync({ line, station, toward })
            }
            onFetchTrainDetails={(line, station, toward, dayType, departs) =>
              fetchTrainDetailsMut.mutateAsync({
                line,
                station,
                toward,
                dayType,
                departs,
              })
            }
            onGoRoutes={() => setView("routes")}
          />
        )}
        {data && view === "routes" && (
          <RoutesView
            data={data}
            onSelectRoute={(id) => setActiveMut.mutate(id)}
            onDeleteRoute={(id) => deleteRouteMut.mutate(id)}
            saving={saveRouteMut.isPending}
            saveError={
              saveRouteMut.isError ? "保存に失敗しました" : null
            }
            onSave={(id, payload) => saveRouteMut.mutateAsync({ id, ...payload })}
          />
        )}
        {data && view === "learn" && (
          <LearnView
            data={data}
            activeRoute={activeRoute}
            onRecord={(segmentId, plannedMin, actualMin) =>
              recordWalkMut.mutate({ segmentId, plannedMin, actualMin })
            }
            onDeleteLog={(id) => deleteLogMut.mutate(id)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------- 発車案内 ----------------

function BoardView({
  data,
  activeRoute,
  direction,
  directionSource,
  onDirection,
  onClearDirection,
  onSelectRoute,
  refreshingLine,
  refreshNote,
  onRefreshLine,
  onManualDelay,
  onFetchTimetable,
  onFetchTrainTimetable,
  onFetchTrainDetails,
  onGoRoutes,
}: {
  data: State;
  activeRoute: Route | null;
  direction: Direction | null;
  directionSource: string | null;
  onDirection: (direction: Direction, source: "gps" | "manual") => void;
  onClearDirection: () => void;
  onSelectRoute: (id: number) => void;
  refreshingLine: string | null;
  refreshNote: { line: string; ok: boolean; message: string } | null;
  onRefreshLine: (line: string) => void;
  onManualDelay: (line: string, delayMin: number | null) => void;
  onFetchTimetable: (
    line: string,
    station: string,
    toward: string,
  ) => Promise<{ ok: boolean; message: string | null }>;
  onFetchTrainTimetable: (
    line: string,
    station: string,
    toward: string,
  ) => Promise<{
    ok: boolean;
    message: string | null;
    weekday: { depart: number; type: string; dest: string }[];
    holiday: { depart: number; type: string; dest: string }[];
    sourceUrl: string | null;
    sourceTitle: string | null;
  }>;
  onFetchTrainDetails: (
    line: string,
    station: string,
    toward: string,
    dayType: DayType,
    departs: number[],
  ) => Promise<{
    ok: boolean;
    message: string | null;
    details: {
      depart: number;
      type: string;
      dest: string;
      stops: TrainStopLike[];
    }[];
  }>;
  onGoRoutes: () => void;
}) {
  const now = nowJst();
  const [dayOverride, setDayOverride] = useState<DayType | null>(null);
  const dayType = dayOverride ?? now.dayType;
  const [positionIdx, setPositionIdx] = useState(0);
  const [selectedOption, setSelectedOption] = useState(0);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  // Direction: manual correction wins; then the server-stored detection;
  // then a local GPS detection made before the server round-trip lands.
  const [manualDir, setManualDir] = useState<Direction | null>(null);
  const [localDir, setLocalDir] = useState<{
    direction: Direction;
    reason: string;
  } | null>(null);
  const [detectReason, setDetectReason] = useState<string | null>(null);
  const prevGpsRef = useRef<{ lat: number; lng: number } | null>(null);
  const gpsDirRef = useRef<Direction | null>(null);

  const dir: Direction =
    manualDir ??
    (directionSource === "manual" ? direction : null) ??
    localDir?.direction ??
    direction ??
    "outbound";
  const isManualDir = manualDir != null || directionSource === "manual";

  const displayRoute: Route | null = useMemo(() => {
    if (!activeRoute) return null;
    return dir === "return" ? reversedRoute(activeRoute) : activeRoute;
  }, [activeRoute, dir]);

  useEffect(() => {
    setPositionIdx(0);
    setSelectedOption(0);
    setSelectedScenarioId(null);
    setSelectedChoiceId(null);
    setGps(null);
    setGpsNote(null);
    setManualDir(null);
    setLocalDir(null);
    setDetectReason(null);
    prevGpsRef.current = null;
    gpsDirRef.current = null;
  }, [activeRoute?.id]);

  useEffect(() => {
    setPositionIdx(0);
    setSelectedOption(0);
    setSelectedScenarioId(null);
    setSelectedChoiceId(null);
  }, [dir]);

  // Keep watching the position while the board is open: direction
  // detection and the walking correction both feed off it, so the user
  // never has to tell the app where they are or which way they travel.
  useEffect(() => {
    if (!activeRoute || !("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        // Permission denied etc.: the manual controls remain available.
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [activeRoute?.id]);

  // Auto-detect direction from each new GPS fix (unless the user has
  // corrected it manually — their correction sticks).
  useEffect(() => {
    if (!gps || !activeRoute || isManualDir) {
      prevGpsRef.current = gps;
      return;
    }
    const det = detectDirection(activeRoute, prevGpsRef.current, gps);
    prevGpsRef.current = gps;
    if (!det) return;
    if (gpsDirRef.current === det.direction) return;
    const wasFirst = gpsDirRef.current == null;
    gpsDirRef.current = det.direction;
    setLocalDir(det);
    setDetectReason(det.reason);
    if (wasFirst || det.direction !== dir) {
      onDirection(det.direction, "gps");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gps, activeRoute?.id]);

  const statuses = useMemo(() => {
    const map = new Map<string, LineStatusRow>();
    for (const s of data.lineStatuses) map.set(s.line, s);
    return map;
  }, [data.lineStatuses]);

  // GPS correction: replace the first walk (origin -> boarding station)
  // with the remaining fraction implied by the straight-line distance.
  const gpsInfo = useMemo(() => {
    if (!gps || !displayRoute) return null;
    const origin = displayRoute.segments[0];
    const walkIdx = displayRoute.segments.findIndex(
      (s, i) => i >= positionIdx && s.type === "walk",
    );
    const walk = walkIdx >= 0 ? displayRoute.segments[walkIdx] : undefined;
    const ride = displayRoute.segments.find(
      (s, i) => i > walkIdx && s.type === "ride",
    );
    if (!origin || !walk || !ride) return null;
    if (origin.lat == null || origin.lng == null) return null;
    if (ride.lat == null || ride.lng == null) return null;
    const total = haversineM(
      { lat: origin.lat, lng: origin.lng },
      { lat: ride.lat, lng: ride.lng },
    );
    const remaining = haversineM(gps, { lat: ride.lat, lng: ride.lng });
    if (total <= 0) return null;
    const base = walkMinutes(walk);
    if (base == null) return null;
    const ratio = Math.min(1, Math.max(0.03, remaining / total));
    return {
      walkSegmentId: walk.id,
      remainingM: remaining,
      correctedMin: Math.max(1, Math.round(base * ratio * 2) / 2),
      station: ride.station ?? ride.toLabel,
    };
  }, [gps, displayRoute, positionIdx]);

  // Timetables are fetched automatically from the route (line +
  // stations), never typed by the user. Cached fetches are merged into
  // the route here; segments still missing one are fetched on open.
  const ttRoute: Route | null = useMemo(
    () => (displayRoute ? applyTimetables(displayRoute, data.timetables) : null),
    [displayRoute, data.timetables],
  );
  const ttAttemptedRef = useRef<Set<string>>(new Set());
  const [ttStatus, setTtStatus] = useState<
    Record<string, { state: "fetching" | "failed"; message?: string }>
  >({});
  const missingTimetables = useMemo(() => {
    if (!ttRoute) return [];
    const out: { key: string; line: string; station: string; toward: string }[] = [];
    for (const seg of ttRoute.segments) {
      if (seg.type !== "ride" || !seg.line) continue;
      const station = seg.station ?? seg.fromLabel;
      const key = timetableKey(seg.line, station, seg.toLabel);
      let needs = seg.departuresWeekday.length === 0;
      if (!needs) {
        // Timetable rows cached before the 2026-11-10 ekitan parser
        // fix can hold the opposite direction's departures merged in
        // (mid-line stations) — treat those ekitan rows as missing so
        // they are refetched once with the fixed parser. Segments
        // with their own stored departures and GTFS rows are exempt.
        const raw = displayRoute?.segments.find((s) => s.id === seg.id);
        const ownTimes = (raw?.departuresWeekday.length ?? 0) > 0;
        if (!ownTimes) {
          const row = data.timetables.find(
            (t) => timetableKey(t.line, t.station, t.toward) === key,
          );
          if (
            row?.sourceUrl?.includes("ekitan.com") &&
            row.fetchedAt != null &&
            Date.parse(row.fetchedAt) < TIMETABLE_FIX_EPOCH_MS
          ) {
            needs = true;
          }
        }
      }
      if (!needs) continue;
      if (!out.some((o) => o.key === key)) {
        out.push({ key, line: seg.line, station, toward: seg.toLabel });
      }
    }
    return out;
  }, [ttRoute, displayRoute, data.timetables]);
  useEffect(() => {
    for (const m of missingTimetables) {
      if (ttAttemptedRef.current.has(m.key)) continue;
      ttAttemptedRef.current.add(m.key);
      setTtStatus((p) => ({ ...p, [m.key]: { state: "fetching" } }));
      void onFetchTimetable(m.line, m.station, m.toward)
        .then((res) => {
          if (!res.ok) {
            setTtStatus((p) => ({
              ...p,
              [m.key]: {
                state: "failed",
                message: res.message ?? "取得できませんでした",
              },
            }));
          } else {
            setTtStatus((p) => {
              const next = { ...p };
              delete next[m.key];
              return next;
            });
          }
        })
        .catch(() => {
          setTtStatus((p) => ({
            ...p,
            [m.key]: { state: "failed", message: "取得に失敗しました" },
          }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingTimetables]);

  // ---- per-train data (type / destination / stop pattern) ----
  // Rail segments additionally fetch the per-train timetable from
  // ekitan: without it the board can only reason about departure
  // minutes, never about 特急 vs 普通, real arrival times, or
  // mid-segment transfers. Failures are silent here — the segment
  // simply stays on the minutes-only model (bus GTFS segments and
  // user-registered timetables have no per-train source).
  type TrainTT = {
    weekday: { depart: number; type: string; dest: string }[];
    holiday: { depart: number; type: string; dest: string }[];
    sourceUrl: string | null;
    sourceTitle: string | null;
  };
  const [trainTTs, setTrainTTs] = useState<Record<string, TrainTT>>({});
  // fetchTrainTT is called concurrently (one exploration per boarded
  // train, all needing the same intermediate stations' timetables),
  // so results and in-flight requests are shared through refs: a
  // caller must never be turned away just because another caller is
  // already fetching the same station — that once silently starved
  // every transfer exploration after the first.
  const trainTTsRef = useRef<Record<string, TrainTT>>({});
  const trainTTInflightRef = useRef<Map<string, Promise<TrainTT | null>>>(
    new Map(),
  );
  const fetchTrainTT = (
    line: string,
    station: string,
    toward: string,
  ): Promise<TrainTT | null> => {
    const key = timetableKey(line, station, toward);
    const have = trainTTsRef.current[key];
    if (have) return Promise.resolve(have);
    const inflight = trainTTInflightRef.current.get(key);
    if (inflight) return inflight;
    const p = (async (): Promise<TrainTT | null> => {
      try {
        const res = await onFetchTrainTimetable(line, station, toward);
        if (!res.ok || res.weekday.length === 0) return null;
        const tt: TrainTT = {
          weekday: res.weekday,
          holiday: res.holiday,
          sourceUrl: res.sourceUrl,
          sourceTitle: res.sourceTitle,
        };
        trainTTsRef.current = { ...trainTTsRef.current, [key]: tt };
        setTrainTTs(trainTTsRef.current);
        return tt;
      } catch {
        return null;
      } finally {
        trainTTInflightRef.current.delete(key);
      }
    })();
    trainTTInflightRef.current.set(key, p);
    return p;
  };
  useEffect(() => {
    if (!displayRoute) return;
    for (const seg of displayRoute.segments) {
      if (seg.type !== "ride" || !seg.line) continue;
      void fetchTrainTT(
        seg.line,
        seg.station ?? seg.fromLabel,
        seg.toLabel,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRoute]);

  const [trainDetails, setTrainDetails] = useState<
    Map<string, TrainStopLike[]>
  >(new Map());
  const detailAttemptedRef = useRef<Set<string>>(new Set());
  const fetchDetailsFor = async (
    line: string,
    station: string,
    toward: string,
    departs: number[],
  ): Promise<void> => {
    const missing = departs.filter(
      (d) =>
        !detailAttemptedRef.current.has(
          trainDetailKey(line, station, toward, dayType, d),
        ),
    );
    if (missing.length === 0) return;
    for (const d of missing) {
      detailAttemptedRef.current.add(
        trainDetailKey(line, station, toward, dayType, d),
      );
    }
    try {
      const res = await onFetchTrainDetails(
        line,
        station,
        toward,
        dayType,
        missing.slice(0, 10),
      );
      if (!res.ok) return;
      setTrainDetails((prev) => {
        const next = new Map(prev);
        for (const det of res.details) {
          next.set(
            trainDetailKey(line, station, toward, dayType, det.depart),
            det.stops,
          );
        }
        return next;
      });
    } catch {
      // details stay unfetched; rideMin estimates keep working
    }
  };

  // Fetch stop lists for the trains the board is likely to use:
  // around each ride leg of the current fastest plan, the caught
  // train plus the next few departures of that segment.
  const detailSeed = useMemo(() => {
    if (!ttRoute) return "";
    const base = computePlans(
      ttRoute,
      dayType,
      statuses,
      now.minutesFloat,
      positionIdx,
    );
    const parts: string[] = [];
    for (const leg of base.options[0]?.legs ?? []) {
      if (leg.kind !== "ride" || leg.schedDepart == null) continue;
      const seg = ttRoute.segments.find((s) => s.id === leg.segmentId);
      if (!seg?.line) continue;
      const station = seg.station ?? seg.fromLabel;
      const key = timetableKey(seg.line, station, seg.toLabel);
      const tt = trainTTs[key];
      if (!tt) continue;
      const list = dayType === "weekday" ? tt.weekday : tt.holiday;
      const depMod = ((leg.schedDepart % 1440) + 1440) % 1440;
      const idx = list.findIndex((t) => t.depart >= depMod);
      const cand = (idx >= 0 ? list.slice(idx, idx + 4) : []).map(
        (t) => t.depart,
      );
      if (cand.length > 0) {
        parts.push(
          `${seg.line}|${station}|${seg.toLabel}|${cand.join(",")}`,
        );
      }
    }
    return parts.join(";");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttRoute, dayType, trainTTs, positionIdx]);
  useEffect(() => {
    if (!detailSeed) return;
    for (const part of detailSeed.split(";")) {
      const [line, station, toward, deps] = part.split("|");
      if (!line || !station || !toward || !deps) continue;
      void fetchDetailsFor(
        line,
        station,
        toward,
        deps.split(",").map(Number),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailSeed]);

  const trainRoute: RouteLike | null = useMemo(
    () =>
      ttRoute
        ? applyTrainData(
            ttRoute,
            Object.entries(trainTTs).map(([key, tt]) => {
              const seg = ttRoute.segments.find(
                (s) =>
                  s.type === "ride" &&
                  s.line &&
                  timetableKey(
                    s.line,
                    s.station ?? s.fromLabel,
                    s.toLabel,
                  ) === key,
              );
              return {
                line: seg?.line ?? "",
                station: seg?.station ?? seg?.fromLabel ?? "",
                toward: seg?.toLabel ?? "",
                weekday: tt.weekday,
                holiday: tt.holiday,
              };
            }),
            trainDetails,
          )
        : null,
    [ttRoute, trainTTs, trainDetails],
  );

  // ---- mid-segment transfer options (first ride segment) ----
  // For each catchable train of the first ride, look at its stopping
  // stations: at a station where a faster train of the same line
  // also stops and arrives at the destination earlier, changing
  // there is a real option. Computed from fetched stop lists only.
  const [transferOptionsMap, setTransferOptionsMap] = useState<
    Record<number, TransferOption[]>
  >({});
  const transferAttemptedRef = useRef<Set<string>>(new Set());
  // Boards whose transfer exploration has finished (with or without
  // a found option); the "no combination" note waits for these.
  const [transferDone, setTransferDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!trainRoute) return;
    const firstRideIdx = trainRoute.segments.findIndex(
      (s, i) => i >= positionIdx && s.type === "ride",
    );
    const seg =
      firstRideIdx >= 0 ? trainRoute.segments[firstRideIdx] : undefined;
    if (!seg?.line) return;
    const station = seg.station ?? seg.fromLabel;
    const trains =
      dayType === "weekday" ? seg.trainsWeekday : seg.trainsHoliday;
    if (!trains || trains.length === 0) return;
    let toPlatform = 0;
    for (let i = positionIdx; i < firstRideIdx; i++) {
      const s = trainRoute.segments[i];
      if (s && s.type === "walk") toPlatform += walkMinutes(s) ?? 0;
    }
    toPlatform += seg.accessMin ?? 0;
    const st = statuses.get(seg.line);
    const delay = st
      ? st.manualDelayMin ?? (st.status === "normal" ? 0 : (st.delayMin ?? 0))
      : 0;
    const need = now.minutesFloat + toPlatform + trainRoute.bufferMin;
    const candidates = trains
      .filter((t) => t.servesDest !== false && t.depart + delay >= need)
      .slice(0, 3);
    const segLine = seg.line;
    const segToward = seg.toLabel;
    const segId = seg.id;
    for (const board of candidates) {
      const attemptKey = `${segId}|${dayType}|${board.depart}`;
      if (transferAttemptedRef.current.has(attemptKey)) continue;
      const stops = trainDetails.get(
        trainDetailKey(segLine, station, segToward, dayType, board.depart),
      );
      if (!stops) continue; // detail not fetched yet; retry when it lands
      transferAttemptedRef.current.add(attemptKey);
      void (async () => {
        try {
        const destCore = stationCore(segToward);
        const bi = stops.findIndex((s) =>
          stationCoreLooseEq(stationCore(s.station), stationCore(station)),
        );
        const ai = stops.findIndex((s) =>
          stationCoreLooseEq(stationCore(s.station), destCore),
        );
        if (bi < 0 || ai <= bi) return;
        const destStop = stops[ai];
        const directArrive = destStop?.arrive ?? destStop?.depart ?? null;
        if (directArrive == null) return;
        const vias = stops.slice(bi + 1, ai).slice(0, 6);
        const found: TransferOption[] = [];
        for (const via of vias) {
          const localArrive = via.arrive ?? via.depart;
          if (localArrive == null) continue;
          const viaStation = stationCore(via.station);
          const tt = await fetchTrainTT(segLine, viaStation, segToward);
          if (!tt) continue;
          const viaList = dayType === "weekday" ? tt.weekday : tt.holiday;
          // Same-platform style change: allow 1 minute at the station.
          const expressCands = viaList
            .filter(
              (t) =>
                t.depart >= localArrive + 1 && t.depart <= localArrive + 30,
            )
            .slice(0, 3);
          if (expressCands.length === 0) continue;
          await fetchDetailsFor(
            segLine,
            viaStation,
            segToward,
            expressCands.map((t) => t.depart),
          );
          // Details arrive via state; read them back with a fresh call
          // pattern: request again (attempted set makes this cheap)
          // and use the action result directly instead.
          try {
            const res = await onFetchTrainDetails(
              segLine,
              viaStation,
              segToward,
              dayType,
              expressCands.map((t) => t.depart),
            );
            if (!res.ok) continue;
            for (const det of res.details) {
              const dStop = det.stops.find((s) =>
                stationCoreLooseEq(stationCore(s.station), destCore),
              );
              const arr = dStop?.arrive ?? dStop?.depart ?? null;
              if (arr == null || arr >= directArrive) continue;
              const candTrain = expressCands.find(
                (t) => t.depart === det.depart,
              );
              found.push({
                boardDepart: board.depart,
                boardType: board.type,
                viaStation,
                localArriveVia: localArrive,
                expressDepart: det.depart,
                expressType: det.type || candTrain?.type || "",
                expressDest: det.dest || candTrain?.dest || "",
                arriveDest: arr,
              });
            }
          } catch {
            // this via station simply yields no option
          }
        }
        if (found.length > 0) {
          setTransferOptionsMap((prev) => {
            const cur = prev[segId] ?? [];
            const merged = [
              ...cur.filter((o) => o.boardDepart !== board.depart),
              ...found,
            ];
            return { ...prev, [segId]: merged };
          });
        }
        } finally {
          setTransferDone((prev) => {
            if (prev.has(attemptKey)) return prev;
            const next = new Set(prev);
            next.add(attemptKey);
            return next;
          });
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainRoute, trainDetails, dayType, positionIdx]);

  const enrichedRoute: RouteLike | null = useMemo(() => {
    if (!trainRoute) return null;
    return {
      ...trainRoute,
      segments: trainRoute.segments.map((s) =>
        transferOptionsMap[s.id]
          ? { ...s, transferOptions: transferOptionsMap[s.id] }
          : s,
      ),
    };
  }, [trainRoute, transferOptionsMap]);

  const planRoute: RouteLike | null = useMemo(() => {
    if (!enrichedRoute) return null;
    if (!gpsInfo) return enrichedRoute;
    return {
      ...enrichedRoute,
      segments: enrichedRoute.segments.map((s) =>
        s.id === gpsInfo.walkSegmentId
          ? { ...s, learnedWalkMin: gpsInfo.correctedMin }
          : s,
      ),
    };
  }, [enrichedRoute, gpsInfo]);

  const plan = useMemo(() => {
    if (!planRoute) return null;
    return computePlans(
      planRoute,
      dayType,
      statuses,
      now.minutesFloat,
      positionIdx,
    );
  }, [planRoute, dayType, statuses, now.minutesFloat, positionIdx]);

  // Scenario comparison: the fastest full traversal vs variants that
  // pass up one departure at a single boarding point, each simulated
  // through every downstream transfer to the final arrival.
  const scenarios = useMemo(() => {
    if (!planRoute) return [];
    return computeScenarios(
      planRoute,
      dayType,
      statuses,
      now.minutesFloat,
      positionIdx,
    );
  }, [planRoute, dayType, statuses, now.minutesFloat, positionIdx]);

  // Focus choices: the trains connectable from this moment at the
  // first boarding point — for each, 乗り換える (mid-segment change
  // onto a faster train) vs 乗り換えない (stay through), and the
  // same for departing one train later. Each choice re-simulates
  // the whole route to the final arrival.
  const focusChoices = useMemo(() => {
    if (!planRoute) return [];
    return computeFocusChoices(
      planRoute,
      dayType,
      statuses,
      now.minutesFloat,
      positionIdx,
    );
  }, [planRoute, dayType, statuses, now.minutesFloat, positionIdx]);

  const requestGps = () => {
    if (!("geolocation" in navigator)) {
      setGpsNote("この端末では位置情報が使えません");
      return;
    }
    setGpsNote("位置情報を取得中…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGps(fix);
        setGpsNote(null);
        if (activeRoute && !isManualDir) {
          const det = detectDirection(activeRoute, null, fix);
          if (det) {
            gpsDirRef.current = det.direction;
            setLocalDir(det);
            setDetectReason(det.reason);
            onDirection(det.direction, "gps");
          }
        }
      },
      () => setGpsNote("位置情報を取得できませんでした"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  if (!activeRoute || !plan) {
    return (
      <div className="py-14 text-center">
        <TrainIcon size={40} className="mx-auto text-[var(--dim)]" />
        <p className="mt-4 text-base font-black">まだ経路が登録されていません</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
          いつもの経路（出発地点→徒歩→電車→目的地）を登録すると、発車時刻は経路から自動で取得し、今いる場所と時刻から乗れる電車をリアルタイムで案内します。
        </p>
        <button
          type="button"
          onClick={onGoRoutes}
          className="mt-5 rounded-md bg-[var(--accent)] px-5 py-2.5 text-sm font-black text-[#0b2013]"
        >
          経路を登録する
        </button>
      </div>
    );
  }

  const shownRoute = displayRoute ?? activeRoute;
  const lines = [
    ...new Set(
      shownRoute.segments
        .filter((s) => s.type === "ride" && s.line)
        .map((s) => s.line as string),
    ),
  ];
  const positions: { idx: number; label: string }[] = [];
  shownRoute.segments.forEach((s, i) => {
    if (s.type === "ride" || i === 0) {
      positions.push({
        idx: i,
        label:
          i === 0
            ? s.toLabel || "出発地点"
            : s.type === "ride"
              ? stationLabel(s.station ?? s.fromLabel)
              : s.fromLabel,
      });
    }
  });
  const main: PlanOption | undefined =
    plan.options[selectedOption] ?? plan.options[0];
  const selectedScenario =
    scenarios.find((s) => s.id === selectedScenarioId) ?? null;
  const selectedChoice =
    focusChoices.find((c) => c.id === selectedChoiceId) ?? null;
  const shownPlan: PlanOption | undefined =
    selectedChoice?.plan ?? selectedScenario?.plan ?? main;
  const baselinePlan = scenarios[0]?.plan ?? null;
  const baselineLegs = new Map(
    (baselinePlan?.legs ?? [])
      .filter((l) => l.kind === "ride")
      .map((l) => [l.segmentId, l] as const),
  );
  const firstRideSeg = shownRoute.segments.find(
    (s) => s.id === plan.firstRideSegmentId,
  );
  const routeEnds = routePoints(activeRoute);
  const endA = routeEnds[0];
  const endB = routeEnds[routeEnds.length - 1];
  const fromEnd = dir === "return" ? endB : endA;
  const toEnd = dir === "return" ? endA : endB;
  const firstRideStatus = firstRideSeg?.line
    ? statuses.get(firstRideSeg.line)
    : undefined;
  const firstRideDelay = effectiveDelayMin(firstRideStatus);

  return (
    <div>
      {/* 経路セレクタ */}
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="経路の選択">
        {data.routes.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={r.id === activeRoute.id}
            onClick={() => onSelectRoute(r.id)}
            className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-bold ${
              r.id === activeRoute.id
                ? "border-[var(--accent)] bg-[#123c26] text-[#4ade80]"
                : "border-[var(--border)] text-[var(--dim)]"
            }`}
          >
            {r.name}
          </button>
        ))}
      </div>

      {/* 方向（自動判定・訂正のみ手動） */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        {fromEnd && toEnd ? (
          <p className="text-sm font-bold">
            {fromEnd.label} <span className="text-[var(--dim)]">→</span>{" "}
            {toEnd.label}
            <span className="ml-2 rounded bg-[#123c26] px-1.5 py-0.5 text-[11px] font-bold text-[#4ade80]">
              {dir === "return" ? "帰り" : "行き"}で表示中
            </span>
          </p>
        ) : (
          <p className="text-sm font-bold">
            <span className="rounded bg-[#123c26] px-1.5 py-0.5 text-[11px] font-bold text-[#4ade80]">
              {dir === "return" ? "帰り" : "行き"}で表示中
            </span>
          </p>
        )}
        <span className="text-[11px] text-[var(--dim)]">
          {isManualDir
            ? "方向はあなたの指定で固定中"
            : detectReason
              ? `自動判定: ${detectReason}`
              : "方向は現在地から自動判定します"}
        </span>
        <button
          type="button"
          className="text-[11px] font-bold text-[var(--dim)] underline"
          onClick={() => {
            const next: Direction = dir === "return" ? "outbound" : "return";
            setManualDir(next);
            onDirection(next, "manual");
          }}
        >
          {dir === "return" ? "行きに切り替え" : "帰りに切り替え"}
        </button>
        {isManualDir && (
          <button
            type="button"
            className="text-[11px] font-bold text-[var(--dim)] underline"
            onClick={() => {
              setManualDir(null);
              gpsDirRef.current = null;
              setLocalDir(null);
              setDetectReason(null);
              prevGpsRef.current = null;
              onClearDirection();
            }}
          >
            自動判定に戻す
          </button>
        )}
      </div>
      {/* 日種と現在地 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="tnum flex items-center gap-1 text-sm text-[var(--dim)]">
          <ClockIcon size={15} /> 現在 {now.clockLabel}
        </span>
        <div className="flex rounded-md border border-[var(--border)]" role="group" aria-label="ダイヤの日種">
          {(
            [
              ["weekday", "平日"],
              ["holiday", "土休日"],
            ] as [DayType, string][]
          ).map(([d, label]) => (
            <button
              key={d}
              type="button"
              aria-pressed={dayType === d}
              onClick={() => setDayOverride(d)}
              className={`px-2.5 py-1 text-xs font-bold ${
                dayType === d
                  ? "bg-[var(--surface2)] text-[var(--text)]"
                  : "text-[var(--dim)]"
              }`}
            >
              {label}ダイヤ
            </button>
          ))}
        </div>
        {dayOverride == null && (
          <span className="text-xs text-[var(--dim)]">（曜日から自動判定）</span>
        )}
      </div>

      {/* 今いる場所 */}
      <div className="mt-3">
        <p className="text-xs font-bold text-[var(--dim)]">今いる場所</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {positions.map((p) => (
            <button
              key={p.idx}
              type="button"
              aria-pressed={positionIdx === p.idx}
              onClick={() => setPositionIdx(p.idx)}
              className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                positionIdx === p.idx
                  ? "border-[var(--warn)] bg-[#3d2c07] text-[#fbbf24]"
                  : "border-[var(--border)] text-[var(--dim)]"
              }`}
            >
              <PinIcon size={12} className="mr-0.5 inline" />
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={requestGps}
            className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-bold text-[var(--dim)]"
          >
            <CrosshairIcon size={12} className="mr-0.5 inline" />
            現在地で補正
          </button>
        </div>
        {gpsNote && <p className="mt-1.5 text-xs text-[var(--warn)]">{gpsNote}</p>}
        {gps && gpsInfo && (
          <p className="mt-1.5 flex items-center gap-2 text-xs font-bold text-[#4ade80]">
            現在地補正中: {stationLabel(gpsInfo.station)}まで直線約
            {Math.round(gpsInfo.remainingM)}m・残り徒歩 約{gpsInfo.correctedMin}
            分（目安）
            <button
              type="button"
              className="text-[var(--dim)] underline"
              onClick={() => setGps(null)}
            >
              解除
            </button>
          </p>
        )}
        {gps && !gpsInfo && (
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            補正には出発地点と乗車駅の地点登録が必要です（経路の編集で、スポット名や住所から登録できます）。
            <button
              type="button"
              className="ml-1 underline"
              onClick={() => setGps(null)}
            >
              解除
            </button>
          </p>
        )}
      </div>

      {/* 発車標ヒーロー */}
      <section
        aria-label="次に乗れる電車"
        className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        {!plan.hasRide && (
          <p className="text-sm text-[var(--dim)]">
            この経路には電車区間がありません。経路の編集から電車区間を追加してください（発車時刻は自動で取得します）。
          </p>
        )}
        {plan.hasRide && plan.firstRideSuspended && (
          <div className="flex items-start gap-2">
            <AlertIcon size={22} className="mt-0.5 shrink-0 text-[var(--danger)]" />
            <div>
              <p className="text-lg font-black text-[var(--danger)]">
                {firstRideSeg?.line} は運転見合わせ中です
              </p>
              <p className="mt-1 text-sm text-[var(--dim)]">
                {firstRideStatus?.summary ||
                  "最新の運行情報を確認してください。"}
              </p>
            </div>
          </div>
        )}
        {plan.hasRide && !plan.firstRideSuspended && !shownPlan && (
          <p className="text-sm text-[var(--dim)]">
            乗れる電車を計算できませんでした。発車時刻と徒歩分数を確認してください。
          </p>
        )}
        {shownPlan && firstRideSeg && (
          <div>
            {selectedChoice && (
              <p className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded bg-[#3d2c07] px-1.5 py-0.5 text-xs font-bold text-[#fbbf24]">
                  選択中: {fmtTime(selectedChoice.boardDepart)}発
                  {selectedChoice.boardType
                    ? ` ${selectedChoice.boardType}`
                    : ""}
                  {selectedChoice.mode === "transfer"
                    ? ` → ${selectedChoice.viaStation}で${selectedChoice.expressType ?? ""}に乗り換え`
                    : selectedChoice.mode === "stay"
                      ? " → 乗り換えず直通"
                      : ""}
                  {selectedChoice.laterBy > 0
                    ? `（${selectedChoice.laterBy}本遅らせ）`
                    : ""}
                </span>
                <button
                  type="button"
                  className="text-xs font-bold text-[var(--dim)] underline"
                  onClick={() => setSelectedChoiceId(null)}
                >
                  最短に戻す
                </button>
              </p>
            )}
            {selectedScenario && selectedScenario.id !== "fastest" && (
              <p className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded bg-[#3d2c07] px-1.5 py-0.5 text-xs font-bold text-[#fbbf24]">
                  シナリオ: {selectedScenario.label}
                </span>
                <button
                  type="button"
                  className="text-xs font-bold text-[var(--dim)] underline"
                  onClick={() => setSelectedScenarioId(null)}
                >
                  最短に戻す
                </button>
              </p>
            )}
            <p className="text-xs font-bold text-[var(--dim)]">
              {shownPlan.nextDay
                ? "本日の運行は終了しています — 明日の始発"
                : plan.endOfService
                  ? "明日の始発"
                  : "次に乗れる電車"}
            </p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="text-lg font-black">{firstRideSeg.line}</span>
              <span className="text-sm text-[var(--dim)]">
                {stationLabel(firstRideSeg.station ?? "")}
              </span>
              {firstRideDelay > 0 && (
                <span className="rounded bg-[#3d2c07] px-1.5 py-0.5 text-xs font-bold text-[#fbbf24]">
                  約{firstRideDelay}分遅れで計算中
                </span>
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
              <p className="tnum text-5xl font-bold leading-none">
                {fmtTime(shownPlan.boardAt)}
                <span className="ml-1 text-xl font-bold">発</span>
              </p>
              <p className="pb-0.5 text-sm text-[var(--dim)]">
                {firstRideDelay > 0 && (
                  <>定刻 {fmtTime(shownPlan.boardAtSched)} ・ </>
                )}
                目的地到着{" "}
                <span className="tnum text-base font-bold text-[var(--text)]">
                  {fmtTime(shownPlan.arriveAt)}
                </span>
              </p>
            </div>
            <div className="mt-3 rounded-lg bg-[var(--bg)] px-3 py-2.5">
              {shownPlan.leaveBy > now.minutesFloat ? (
                <p className="flex items-baseline gap-2">
                  <span className="text-sm font-bold">出発まで あと</span>
                  <span className="tnum text-3xl font-bold text-[var(--accent)]">
                    {fmtCountdown((shownPlan.leaveBy - now.minutesFloat) * 60)}
                  </span>
                  <span className="text-xs text-[var(--dim)]">
                    （{fmtTime(shownPlan.leaveBy)} 出発）
                  </span>
                </p>
              ) : (
                <p className="text-xl font-black text-[var(--warn)]">
                  今すぐ出発すれば間に合います
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--dim)]">
                駅のホームまで約{Math.round(shownPlan.toPlatformMin)}分
                {(() => {
                  const firstWalk = shownPlan.legs.find((l) => l.kind === "walk");
                  return firstWalk?.learned ? "（あなたの歩行ペースで学習済み）" : "";
                })()}
                ＋余裕{activeRoute.bufferMin}分で計算しています
              </p>
            </div>

            {/* 行程の内訳 */}
            <ol className="mt-3 space-y-2">
              {shownPlan.legs.map((leg, i) => {
                // Platform wait comes from predict.ts (leg.waitMin),
                // which already excludes the walk minutes and the
                // access minutes between the two rides. Recomputing
                // it here from depart − previous arrival alone would
                // count the transfer walk as waiting a second time.
                const waitMin = leg.kind === "ride" ? leg.waitMin : null;
                return (
                  <li key={`${leg.segmentId}-${i}`} className="flex items-start gap-2.5 text-sm">
                    {leg.kind === "walk" ? (
                      <WalkIcon size={17} className="mt-0.5 shrink-0 text-[var(--warn)]" />
                    ) : (
                      <TrainIcon size={17} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                    )}
                    <div className="min-w-0">
                      {leg.kind === "walk" ? (
                        <p>
                          {leg.label}
                          <span className="tnum ml-2 font-bold">
                            約{leg.walkMin ?? "?"}分
                          </span>
                          {leg.learned && (
                            <span className="ml-1.5 rounded bg-[#123c26] px-1 py-0.5 text-[11px] font-bold text-[#4ade80]">
                              学習済み
                            </span>
                          )}
                        </p>
                      ) : leg.transferWithin ? (
                        <div>
                          <p>
                            <span className="font-bold">{leg.line}</span>{" "}
                            {leg.trainType && (
                              <span className="mr-1 rounded bg-[var(--surface2)] px-1 py-0.5 text-[11px] font-bold">
                                {leg.trainType}
                              </span>
                            )}
                            {leg.fromStation}
                            <span className="tnum ml-2 font-bold">
                              {leg.depart != null ? fmtTime(leg.depart) : ""}発
                            </span>
                            <span className="text-[var(--dim)]"> → </span>
                            {leg.transferWithin.viaStation}
                            <span className="tnum ml-1.5">
                              {fmtTime(leg.transferWithin.localArriveVia)}着
                            </span>
                          </p>
                          <p className="mt-0.5">
                            <span className="rounded bg-[#123c26] px-1 py-0.5 text-[11px] font-bold text-[#4ade80]">
                              {leg.transferWithin.viaStation}で乗り換え
                            </span>{" "}
                            <span className="font-bold">
                              {leg.transferWithin.expressType}
                            </span>
                            {leg.transferWithin.expressDest
                              ? ` ${leg.transferWithin.expressDest}行き`
                              : ""}
                            <span className="tnum ml-2 font-bold">
                              {fmtTime(leg.transferWithin.expressDepart)}発
                            </span>
                            <span className="text-[var(--dim)]"> → </span>
                            {leg.toStation}
                            <span className="tnum ml-1.5 font-bold">
                              {leg.arrive != null ? fmtTime(leg.arrive) : ""}着
                            </span>
                            {leg.delayMin > 0 && (
                              <span className="ml-1.5 text-xs font-bold text-[#fbbf24]">
                                +{leg.delayMin}分
                              </span>
                            )}
                          </p>
                          {waitMin != null && (
                            <span className="block text-xs text-[var(--dim)]">
                              乗り換え待ち 約{waitMin}分
                            </span>
                          )}
                        </div>
                      ) : (
                        <p>
                          <span className="font-bold">{leg.line}</span>{" "}
                          {leg.trainType && (
                            <span className="mr-1 rounded bg-[var(--surface2)] px-1 py-0.5 text-[11px] font-bold">
                              {leg.trainType}
                            </span>
                          )}
                          {leg.fromStation} → {leg.toStation}
                          {leg.trainDest && (
                            <span className="ml-1 text-xs text-[var(--dim)]">
                              {leg.trainDest}行き
                            </span>
                          )}
                          <span className="tnum ml-2 font-bold">
                            {leg.depart != null ? fmtTime(leg.depart) : ""}発 →{" "}
                            {leg.arrive != null ? fmtTime(leg.arrive) : ""}着
                          </span>
                          {leg.delayMin > 0 && (
                            <span className="ml-1.5 text-xs font-bold text-[#fbbf24]">
                              +{leg.delayMin}分
                            </span>
                          )}
                          {leg.suspended && (
                            <span className="ml-1.5 text-xs font-bold text-[var(--danger)]">
                              運転見合わせ
                            </span>
                          )}
                          {waitMin != null && (
                            <span className="block text-xs text-[var(--dim)]">
                              乗り換え待ち 約{waitMin}分
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {plan.missingWalk && (
          <p className="mt-2 text-xs text-[var(--warn)]">
            徒歩分数が未設定の区間があり、0分として計算しています。
          </p>
        )}
      </section>

      {/* 次の候補 */}
      {plan.options.length > 1 && (
        <section aria-label="その次の候補" className="mt-3">
          <h2 className="text-xs font-bold text-[var(--dim)]">その他の候補</h2>
          <div className="mt-1.5 space-y-1.5">
            {plan.options.map((opt, i) =>
              i === (plan.options[selectedOption] ? selectedOption : 0) ? null : (
                <button
                  key={opt.boardAtSched}
                  type="button"
                  onClick={() => {
                    setSelectedScenarioId(null);
                    setSelectedChoiceId(null);
                    setSelectedOption(i);
                  }}
                  className="tnum flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-sm"
                >
                  <span className="font-bold">{fmtTime(opt.boardAt)}発</span>
                  <span className="text-[var(--dim)]">
                    {fmtTime(opt.leaveBy)}出発 → {fmtTime(opt.arriveAt)}着
                  </span>
                </button>
              ),
            )}
          </div>
        </section>
      )}

      {/* 乗り換えの選択（特急まで考慮） */}
      {focusChoices.length > 0 && firstRideSeg && (
        <section aria-label="乗り換えの選択" className="mt-5">
          <h2 className="text-xs font-bold text-[var(--dim)]">
            乗り換えの選択（{stationLabel(firstRideSeg.station ?? firstRideSeg.fromLabel)}から乗れる電車）
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            いまから乗り継げる電車ごとに、途中の駅で速い電車（特急・快速など）に「乗り換える」か、そのまま「乗り換えない」かを切り替えて、その先の駅で乗れる電車と最終到着がどう変わるか比べられます。出発を1本遅らせた場合も同じ見方です。各タブには最終到着を表示しています。「待ち」は徒歩と駅構内の移動を除いた、ホームで待つ時間だけです（徒歩は連鎖の中に別に表示されます）。
          </p>
          {(() => {
            const groups: {
              depart: number;
              type: string | null;
              dest: string | null;
              laterBy: number;
              choices: typeof focusChoices;
            }[] = [];
            for (const c of focusChoices) {
              let g = groups.find((x) => x.depart === c.boardDepart);
              if (!g) {
                g = {
                  depart: c.boardDepart,
                  type: c.boardType,
                  dest: c.boardDest,
                  laterBy: c.laterBy,
                  choices: [],
                };
                groups.push(g);
              }
              g.choices.push(c);
            }
            const selGroup =
              groups.find((g) =>
                g.choices.some((c) => c.id === selectedChoice?.id),
              ) ?? groups[0];
            const selChoice =
              selGroup?.choices.find((c) => c.id === selectedChoice?.id) ??
              selGroup?.choices[0];
            const fastestArrive = Math.min(
              ...focusChoices.map((c) => c.plan.arriveAt),
            );
            const hasTrainData = focusChoices.some(
              (c) => c.boardType != null,
            );
            const anyTransfer = focusChoices.some(
              (c) => c.mode === "transfer",
            );
            return (
              <div className="mt-2">
                {/* 出発のタブ */}
                <div
                  className="flex flex-wrap gap-1.5"
                  role="tablist"
                  aria-label="出発する電車の選択"
                >
                  {groups.map((g) => {
                    const active = selGroup?.depart === g.depart;
                    // The point of the tab is the END of the chain:
                    // show where this departure ultimately lands
                    // (best variant of this departure), not just the
                    // first leg, before the user even taps.
                    const gArrive = Math.min(
                      ...g.choices.map((c) => c.plan.arriveAt),
                    );
                    const gDelta = Math.round(gArrive - fastestArrive);
                    return (
                      <button
                        key={g.depart}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => {
                          const def =
                            g.choices.find((c) => c.mode === "transfer") ??
                            g.choices[0];
                          if (def) {
                            setSelectedScenarioId(null);
                            setSelectedChoiceId(def.id);
                          }
                        }}
                        className={`tnum rounded-lg border px-3 py-2 text-left text-sm ${
                          active
                            ? "border-[var(--accent)] bg-[#123c26] text-[#4ade80]"
                            : "border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
                        }`}
                      >
                        <span className="font-bold">
                          {fmtTime(g.depart)}発
                        </span>
                        {g.type && (
                          <span className="ml-1.5 font-bold">{g.type}</span>
                        )}
                        {g.dest && (
                          <span className="ml-1 text-xs">{g.dest}行き</span>
                        )}
                        {g.laterBy > 0 && (
                          <span className="ml-1.5 rounded bg-[#3d2c07] px-1 py-0.5 text-[11px] font-bold text-[#fbbf24]">
                            {g.laterBy}本遅らせる
                          </span>
                        )}
                        <span className="block text-[11px] font-bold opacity-80">
                          最終 {fmtTime(gArrive)}着
                          {gDelta > 0
                            ? `（最速より+${gDelta}分）`
                            : "（最速）"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* 乗り換える／乗り換えないのタブ */}
                {selGroup && selGroup.choices.length > 1 && (
                  <div
                    className="mt-2 grid grid-cols-2 gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
                    role="tablist"
                    aria-label="途中で乗り換えるかの選択"
                  >
                    {selGroup.choices.map((c) => {
                      const active = selChoice?.id === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => {
                            setSelectedScenarioId(null);
                            setSelectedChoiceId(c.id);
                          }}
                          className={`rounded-md px-2 py-2 text-sm font-black ${
                            active
                              ? "bg-[var(--accent)] text-[#0b2013]"
                              : "text-[var(--dim)]"
                          }`}
                        >
                          {c.mode === "transfer"
                            ? `${c.viaStation}で乗り換える`
                            : "乗り換えない"}
                          <span className="block text-[11px] font-bold opacity-80">
                            {c.mode === "transfer"
                              ? `${c.expressType ?? ""}に乗り換え`
                              : "直通・座ったまま"}
                            {" → 最終 "}
                            {fmtTime(c.plan.arriveAt)}着
                            {Math.round(c.plan.arriveAt - fastestArrive) > 0
                              ? `（+${Math.round(c.plan.arriveAt - fastestArrive)}分）`
                              : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* 選択中の選択肢の結果 */}
                {selChoice && (
                  <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <p className="text-sm font-black">
                        {fmtTime(selChoice.boardDepart)}発
                        {selChoice.boardType
                          ? ` ${selChoice.boardType}`
                          : ""}
                        {selChoice.mode === "transfer"
                          ? ` → ${selChoice.viaStation}で${selChoice.expressType ?? ""}に乗り換え`
                          : selChoice.mode === "stay"
                            ? " → 乗り換えず直通"
                            : ""}
                      </p>
                      <p className="tnum text-sm">
                        <span className="mr-1 text-xs text-[var(--dim)]">
                          最終到着
                        </span>
                        <span className="text-lg font-bold">
                          {fmtTime(selChoice.plan.arriveAt)}
                        </span>
                        {Math.round(selChoice.plan.arriveAt - fastestArrive) >
                          0 && (
                          <span className="ml-1.5 rounded bg-[#3d2c07] px-1.5 py-0.5 text-[11px] font-bold text-[#fbbf24]">
                            最速より +
                            {Math.round(
                              selChoice.plan.arriveAt - fastestArrive,
                            )}
                            分
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--dim)]">
                      乗り換え待ち合計 {selChoice.plan.totalWaitMin}分
                    </p>
                    <ol className="mt-2 space-y-1.5">
                      {selChoice.plan.legs.map((leg, legIdx) => {
                        if (leg.kind === "walk") {
                          // Walk legs belong in the chain: the wait
                          // shown at the next ride is what remains
                          // AFTER this walk (and the station access),
                          // so the sequence arrival → walk → wait →
                          // departure must be readable as-is.
                          return (
                            <li
                              key={`${leg.segmentId}-${legIdx}`}
                              className="flex items-center gap-1.5 text-xs text-[var(--dim)]"
                            >
                              <WalkIcon size={13} className="shrink-0" />
                              徒歩 {leg.label}
                              <span className="tnum font-bold">
                                約{leg.walkMin ?? "?"}分
                              </span>
                            </li>
                          );
                        }
                        // Cascade annotation: when this departure
                        // group has the other variant (乗り換える /
                        // 乗り換えない), name the train that variant
                        // catches at THIS downstream station, so the
                        // knock-on difference is visible per station
                        // rather than only in the final arrival.
                        const sibling =
                          selGroup && selGroup.choices.length > 1
                            ? selGroup.choices.find(
                                (c) => c.id !== selChoice.id,
                              )
                            : undefined;
                        const sibLeg = sibling?.plan.legs.find(
                          (l) =>
                            l.kind === "ride" &&
                            l.segmentId === leg.segmentId,
                        );
                        const sibDiffers =
                          sibLeg != null &&
                          sibLeg.depart != null &&
                          leg.depart != null &&
                          Math.round(sibLeg.depart) !==
                            Math.round(leg.depart);
                        return (
                          <li
                            key={`${leg.segmentId}-${legIdx}`}
                            className="text-sm"
                          >
                            {leg.waitMin != null && (
                              <span
                                className={`mb-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold ${
                                  leg.waitMin >= 10
                                    ? "bg-[#3d2c07] text-[#fbbf24]"
                                    : "bg-[var(--surface2)] text-[var(--dim)]"
                                }`}
                              >
                                {leg.fromStation}で待ち {leg.waitMin}分
                              </span>
                            )}
                            <p>
                              <span className="font-bold">{leg.line}</span>{" "}
                              {leg.trainType && (
                                <span className="mr-1 rounded bg-[var(--surface2)] px-1 py-0.5 text-[11px] font-bold">
                                  {leg.trainType}
                                </span>
                              )}
                              {leg.fromStation}
                              <span className="tnum ml-1.5 font-bold">
                                {leg.depart != null
                                  ? fmtTime(leg.depart)
                                  : ""}
                                発
                              </span>
                              {leg.transferWithin ? (
                                <>
                                  <span className="text-[var(--dim)]">
                                    {" "}
                                    →{" "}
                                  </span>
                                  {leg.transferWithin.viaStation}
                                  <span className="tnum ml-1">
                                    {fmtTime(
                                      leg.transferWithin.localArriveVia,
                                    )}
                                    着
                                  </span>
                                  <span className="ml-1 rounded bg-[#123c26] px-1 py-0.5 text-[11px] font-bold text-[#4ade80]">
                                    {leg.transferWithin.expressType}
                                    に乗り換え{" "}
                                    {fmtTime(leg.transferWithin.expressDepart)}
                                    発
                                  </span>
                                </>
                              ) : null}
                              <span className="text-[var(--dim)]"> → </span>
                              {leg.toStation}
                              <span className="tnum ml-1.5">
                                {leg.arrive != null
                                  ? fmtTime(leg.arrive)
                                  : ""}
                                着
                              </span>
                            </p>
                            {sibDiffers && sibLeg && (
                              <p className="text-[11px] font-bold text-[var(--dim)]">
                                もう一方の選択では、この駅で{" "}
                                <span className="tnum">
                                  {fmtTime(sibLeg.depart as number)}発
                                </span>
                                に乗る
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                    <button
                      type="button"
                      disabled={selectedChoice?.id === selChoice.id}
                      onClick={() => {
                        setSelectedScenarioId(null);
                        setSelectedChoiceId(selChoice.id);
                      }}
                      className={`mt-2 rounded-lg border px-3 py-1.5 text-xs font-bold ${
                        selectedChoice?.id === selChoice.id
                          ? "border-[var(--accent)] text-[#4ade80]"
                          : "border-[var(--border)] text-[var(--dim)]"
                      }`}
                    >
                      {selectedChoice?.id === selChoice.id
                        ? "この選択を表示中（上の発車案内に反映）"
                        : "この選択で表示"}
                    </button>
                  </div>
                )}
                {!hasTrainData && (
                  <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                    この区間は列車ごとの種別データ（駅探の列車別時刻表）が取得できていないため、途中の乗り換え判定はできません。出発を遅らせる比較のみ表示しています（バスのGTFS区間と登録済み時刻表の区間も同様です）。
                  </p>
                )}
                {hasTrainData &&
                  !anyTransfer &&
                  (() => {
                    const boards = [
                      ...new Set(focusChoices.map((c) => c.boardDepart)),
                    ];
                    const done =
                      firstRideSeg != null &&
                      boards.length > 0 &&
                      boards.every((d) =>
                        transferDone.has(
                          `${firstRideSeg.id}|${dayType}|${d}`,
                        ),
                      );
                    return done ? (
                      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                        いま乗り継げる電車では、途中の駅で速い電車に乗り換えても降車駅への到着が早くなる組み合わせはありませんでした（各電車の停車駅と到着時刻で判定）。
                      </p>
                    ) : (
                      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                        途中の駅で速い電車に乗り換えられる組み合わせを確認中…
                      </p>
                    );
                  })()}
              </div>
            );
          })()}
        </section>
      )}

      {/* シナリオ比較 */}
      {scenarios.length > 1 && baselinePlan && (
        <section aria-label="シナリオ比較" className="mt-5">
          <h2 className="text-xs font-bold text-[var(--dim)]">
            シナリオ比較（今からこの経路を辿ったら）
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            各駅で最初に乗れる電車に乗り継ぐ「最短」と、どこか1か所で1本見送る場合を、最後の到着まで計算し直した比較です。途中で早く着いても最後の乗り換えで長く待つかどうかが、ここで見分けられます。「待ち」は徒歩と駅構内の移動を除いた、ホームで待つ時間だけです。
          </p>
          <div className="mt-2 space-y-2">
            {scenarios.map((s) => {
              const isBaseline = s.id === "fastest";
              const arriveDiff = Math.round(s.plan.arriveAt - baselinePlan.arriveAt);
              const selected = selectedScenarioId === s.id;
              return (
                <div
                  key={s.id}
                  className={`rounded-xl border bg-[var(--surface)] p-3 ${
                    selected
                      ? "border-[var(--accent)]"
                      : "border-[var(--border)]"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="text-sm font-black">{s.label}</p>
                    <p className="tnum text-sm">
                      <span className="mr-1 text-xs text-[var(--dim)]">
                        最終到着
                      </span>
                      <span className="text-lg font-bold">
                        {fmtTime(s.plan.arriveAt)}
                      </span>
                    </p>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--dim)]">
                    {s.description}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] font-bold">
                    {isBaseline ? (
                      <span className="rounded bg-[#123c26] px-1.5 py-0.5 text-[#4ade80]">
                        最短
                      </span>
                    ) : arriveDiff > 0 ? (
                      <span className="rounded bg-[#3d2c07] px-1.5 py-0.5 text-[#fbbf24]">
                        到着 +{arriveDiff}分
                      </span>
                    ) : (
                      <span className="rounded bg-[#123c26] px-1.5 py-0.5 text-[#4ade80]">
                        到着は最短と同じ
                      </span>
                    )}
                    <span className="rounded bg-[var(--surface2)] px-1.5 py-0.5 text-[var(--dim)]">
                      乗り換え待ち合計 {s.plan.totalWaitMin}分
                    </span>
                  </div>
                  <ol className="mt-2 space-y-1.5">
                    {s.plan.legs.map((leg, legIdx) => {
                        if (leg.kind === "walk") {
                          return (
                            <li
                              key={`${leg.segmentId}-${legIdx}`}
                              className="flex items-center gap-1.5 text-xs text-[var(--dim)]"
                            >
                              <WalkIcon size={13} className="shrink-0" />
                              徒歩 {leg.label}
                              <span className="tnum font-bold">
                                約{leg.walkMin ?? "?"}分
                              </span>
                            </li>
                          );
                        }
                        const baseLeg = baselineLegs.get(leg.segmentId);
                        const diff =
                          !isBaseline &&
                          baseLeg?.depart != null &&
                          leg.depart != null
                            ? Math.round(leg.depart - baseLeg.depart)
                            : 0;
                        return (
                          <li key={`${leg.segmentId}-${legIdx}`} className="text-sm">
                            {leg.waitMin != null && (
                              <span
                                className={`mb-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold ${
                                  leg.waitMin >= 10
                                    ? "bg-[#3d2c07] text-[#fbbf24]"
                                    : "bg-[var(--surface2)] text-[var(--dim)]"
                                }`}
                              >
                                {leg.fromStation}で待ち {leg.waitMin}分
                              </span>
                            )}
                            <p>
                              <span className="font-bold">{leg.line}</span>{" "}
                              {leg.trainType && (
                                <span className="mr-1 rounded bg-[var(--surface2)] px-1 py-0.5 text-[11px] font-bold">
                                  {leg.trainType}
                                </span>
                              )}
                              {leg.fromStation}
                              <span
                                className={`tnum ml-1.5 font-bold ${
                                  diff !== 0 ? "text-[#fbbf24]" : ""
                                }`}
                              >
                                {leg.depart != null ? fmtTime(leg.depart) : ""}発
                              </span>
                              {diff !== 0 && (
                                <span className="ml-1 text-[11px] font-bold text-[#fbbf24]">
                                  （最短より{diff > 0 ? "+" : ""}
                                  {diff}分）
                                </span>
                              )}
                              {leg.transferWithin ? (
                                <>
                                  <span className="text-[var(--dim)]"> → </span>
                                  {leg.transferWithin.viaStation}
                                  <span className="tnum ml-1">
                                    {fmtTime(leg.transferWithin.localArriveVia)}着
                                  </span>
                                  <span className="ml-1 rounded bg-[#123c26] px-1 py-0.5 text-[11px] font-bold text-[#4ade80]">
                                    {leg.transferWithin.expressType}に乗り換え{" "}
                                    {fmtTime(leg.transferWithin.expressDepart)}発
                                  </span>
                                </>
                              ) : null}
                              <span className="text-[var(--dim)]"> → </span>
                              {leg.toStation}
                              <span className="tnum ml-1.5">
                                {leg.arrive != null ? fmtTime(leg.arrive) : ""}着
                              </span>
                            </p>
                          </li>
                        );
                      })}
                  </ol>
                  <button
                    type="button"
                    disabled={selected}
                    onClick={() => {
                      setSelectedChoiceId(null);
                      setSelectedScenarioId(s.id);
                    }}
                    className={`mt-2 rounded-lg border px-3 py-1.5 text-xs font-bold ${
                      selected
                        ? "border-[var(--accent)] text-[#4ade80]"
                        : "border-[var(--border)] text-[var(--dim)]"
                    }`}
                  >
                    {selected ? "このシナリオを表示中" : "このシナリオで表示"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 時刻表（自動取得） */}
      <section aria-label="時刻表の自動取得" className="mt-5">
        <h2 className="text-xs font-bold text-[var(--dim)]">時刻表（経路から自動取得）</h2>
        <div className="mt-1.5 space-y-1.5">
          {(ttRoute?.segments ?? [])
            .filter((s) => s.type === "ride" && s.line)
            .map((seg) => {
              const station = seg.station ?? seg.fromLabel;
              const key = timetableKey(seg.line as string, station, seg.toLabel);
              const cached = data.timetables.find(
                (t) => timetableKey(t.line, t.station, t.toward) === key,
              );
              const st = ttStatus[key];
              const hasTimes = seg.departuresWeekday.length > 0;
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs"
                >
                  <span className="font-bold">
                    {seg.line} {stationLabel(station)}（{seg.toLabel}方面）
                  </span>
                  {st?.state === "fetching" ? (
                    <span className="text-[var(--dim)]">時刻表を自動取得中…</span>
                  ) : hasTimes && cached ? (
                    <>
                      <span className="rounded bg-[#123c26] px-1.5 py-0.5 font-bold text-[#4ade80]">
                        自動取得済み
                      </span>
                      <span className="text-[var(--dim)]">
                        {minutesAgo(cached.fetchedAt)}
                      </span>
                      {cached.sourceUrl && (
                        <a
                          href={cached.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--dim)] underline"
                        >
                          出典: {cached.sourceTitle ?? "時刻表ページ"}
                        </a>
                      )}
                      <button
                        type="button"
                        className="font-bold text-[var(--dim)] underline"
                        onClick={() => {
                          ttAttemptedRef.current.delete(key);
                          setTtStatus((p) => ({
                            ...p,
                            [key]: { state: "fetching" },
                          }));
                          void onFetchTimetable(
                            seg.line as string,
                            station,
                            seg.toLabel,
                          ).then((res) => {
                            if (!res.ok) {
                              setTtStatus((p) => ({
                                ...p,
                                [key]: {
                                  state: "failed",
                                  message: res.message ?? "取得できませんでした",
                                },
                              }));
                            }
                          });
                        }}
                      >
                        再取得
                      </button>
                    </>
                  ) : hasTimes ? (
                    <span className="text-[var(--dim)]">
                      登録済みの時刻表を使用中
                    </span>
                  ) : (
                    <>
                      <span className="font-bold text-[var(--warn)]">
                        時刻表を自動取得できませんでした
                        {st?.message ? `: ${st.message}` : ""}
                      </span>
                      <button
                        type="button"
                        className="font-bold underline"
                        onClick={() => {
                          ttAttemptedRef.current.delete(key);
                          setTtStatus((p) => ({
                            ...p,
                            [key]: { state: "fetching" },
                          }));
                          void onFetchTimetable(
                            seg.line as string,
                            station,
                            seg.toLabel,
                          );
                        }}
                      >
                        再試行
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </section>

      {/* データについて */}
      <section aria-label="データについて" className="mt-5">
        <h2 className="text-xs font-bold text-[var(--dim)]">データについて</h2>
        <div className="mt-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed text-[var(--dim)]">
          <p>
            鉄道の路線図・時刻表は駅探と全国駅データ（HeartRails）から、バスの路線図・時刻表はGTFSデータリポジトリ（国土交通省）に収録された事業者のGTFSデータから取得しています（データ提供者の表記は各路線図・時刻表の出典に表示）。
          </p>
          <p className="mt-1">
            鉄道については、駅探の列車別ページから列車ごとの種別（普通・快速・特急など）と各駅の到着・発車時刻も取得し、降車駅への実際の到着時刻と、途中の駅で速い電車へ乗り換える選択肢の判定に使っています。バス（GTFS）区間と登録済み時刻表の区間には列車単位のデータがないため、乗り換え判定の対象外です。
          </p>
          <p className="mt-1">
            京都市バスなど一部の事業者のGTFSデータは公共交通オープンデータセンター（ODPT）でのみ公開されており、利用には無料のアクセストークン（開発者登録）が必要です。このアプリにはトークンが設定されていないため、それらの事業者は路線図・時刻表の自動取得の対象外です。
          </p>
        </div>
      </section>

      {/* 運行情報 */}
      <section aria-label="運行情報" className="mt-5">
        <h2 className="text-xs font-bold text-[var(--dim)]">運行情報（遅延の反映）</h2>
        <div className="mt-1.5 space-y-2">
          {lines.map((line) => (
            <LineStatusCard
              key={line}
              line={line}
              status={statuses.get(line)}
              refreshing={refreshingLine === line}
              note={refreshNote?.line === line ? refreshNote : null}
              onRefresh={() => onRefreshLine(line)}
              onManualDelay={(d) => onManualDelay(line, d)}
            />
          ))}
          {lines.length === 0 && (
            <p className="text-sm text-[var(--dim)]">電車区間がありません。</p>
          )}
        </div>
      </section>
    </div>
  );
}

function LineStatusCard({
  line,
  status,
  refreshing,
  note,
  onRefresh,
  onManualDelay,
}: {
  line: string;
  status: LineStatusRow | undefined;
  refreshing: boolean;
  note: { ok: boolean; message: string } | null;
  onRefresh: () => void;
  onManualDelay: (delayMin: number | null) => void;
}) {
  const [manualInput, setManualInput] = useState("");
  const meta = STATUS_META[status?.status ?? "unknown"];
  const effective = effectiveDelayMin(status);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-black">
          <TrainIcon size={16} className="text-[var(--accent)]" />
          {line}
          <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${meta.cls}`}>
            {status?.status === "delayed" && effective > 0
              ? `約${effective}分遅れ`
              : meta.label}
          </span>
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold disabled:opacity-50"
          aria-label={`${line}の運行情報を更新`}
        >
          <RefreshIcon size={13} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "取得中" : "更新"}
        </button>
      </div>
      {status?.summary && (
        <p className="mt-1.5 text-xs text-[var(--dim)]">{status.summary}</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--dim)]">
        <span>{minutesAgo(status?.fetchedAt ?? null)}</span>
        {status?.sourceUrl && (
          <a
            href={status.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            情報元: {status.sourceTitle ?? "運行情報ページ"}
          </a>
        )}
      </p>
      {note && (
        <p
          className={`mt-1 text-xs font-bold ${note.ok ? "text-[#4ade80]" : "text-[var(--danger)]"}`}
        >
          {note.message}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
        {status?.manualDelayMin != null ? (
          <p className="text-xs font-bold text-[#fbbf24]">
            手動の遅延 {status.manualDelayMin}分 で計算中
            <button
              type="button"
              className="ml-2 text-[var(--dim)] underline"
              onClick={() => onManualDelay(null)}
            >
              解除
            </button>
          </p>
        ) : (
          <>
            <label className="text-xs text-[var(--dim)]" htmlFor={`manual-${line}`}>
              遅延を手動で反映（分）
            </label>
            <input
              id={`manual-${line}`}
              aria-label={`${line}の手動遅延分数`}
              type="number"
              min={0}
              max={300}
              className="tnum w-20 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
            />
            <button
              type="button"
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-bold"
              onClick={() => {
                const n = Number(manualInput);
                if (manualInput.trim() !== "" && Number.isFinite(n)) {
                  onManualDelay(Math.max(0, Math.round(n)));
                  setManualInput("");
                }
              }}
            >
              設定
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- 経路 ----------------

function RoutesView({
  data,
  onSelectRoute,
  onDeleteRoute,
  saving,
  saveError,
  onSave,
}: {
  data: State;
  onSelectRoute: (id: number) => void;
  onDeleteRoute: (id: number) => void;
  saving: boolean;
  saveError: string | null;
  onSave: (id: number | null, payload: RoutePayload) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<
    | { routeId: number | null; name: string; buffer: number; drafts: DraftSegment[] }
    | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const startCreate = () => {
    const origin = newDraftSegment("origin");
    origin.place.name = "自宅";
    const walk = newDraftSegment("walk");
    walk.place.name = "自宅";
    const ride = newDraftSegment("ride");
    const walk2 = newDraftSegment("walk");
    setEditing({
      routeId: null,
      name: "",
      buffer: 1,
      drafts: [origin, walk, ride, walk2],
    });
    setLocalError(null);
  };
  const startEdit = (route: Route) => {
    setEditing({
      routeId: route.id,
      name: route.name,
      buffer: route.bufferMin,
      drafts: routeToDraft(route),
    });
    setLocalError(null);
  };

  if (editing) {
    return (
      <RouteEditor
        title={editing.routeId == null ? "経路を登録" : "経路を編集"}
        initialName={editing.name}
        initialBuffer={editing.buffer}
        initialSegments={editing.drafts}
        saving={saving}
        saveError={saveError}
        onCancel={() => setEditing(null)}
        onSave={(payload) => {
          void onSave(editing.routeId, payload).then(() => setEditing(null));
        }}
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={startCreate}
        className="w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-sm font-black text-[#0b2013]"
      >
        ＋ 新しい経路を登録
      </button>
      {localError && (
        <p className="mt-2 text-sm text-[var(--danger)]">{localError}</p>
      )}
      <div className="mt-3 space-y-2">
        {data.routes.map((route) => {
          const summary = route.segments
            .map((s) =>
              s.type === "ride"
                ? `${s.line ?? ""} ${s.station ?? ""}→${s.toLabel}`
                : s.type === "walk"
                  ? `徒歩${s.learnedWalkMin ?? s.baseWalkMin ?? "?"}分`
                  : s.toLabel,
            )
            .join(" → ");
          const isActive = route.id === data.activeRouteId;
          return (
            <div
              key={route.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black">
                  {route.name}
                  {isActive && (
                    <span className="ml-2 rounded bg-[#123c26] px-1.5 py-0.5 text-[11px] font-bold text-[#4ade80]">
                      選択中
                    </span>
                  )}
                </p>
                <div className="flex gap-1.5">
                  {!isActive && (
                    <button
                      type="button"
                      className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold"
                      onClick={() => onSelectRoute(route.id)}
                    >
                      選択する
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold"
                    onClick={() => startEdit(route)}
                  >
                    編集
                  </button>
                  {confirmDelete === route.id ? (
                    <button
                      type="button"
                      className="rounded-md bg-[var(--danger)] px-2.5 py-1.5 text-xs font-bold text-white"
                      onClick={() => {
                        onDeleteRoute(route.id);
                        setConfirmDelete(null);
                      }}
                    >
                      本当に削除
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`${route.name}を削除`}
                      className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--danger)]"
                      onClick={() => setConfirmDelete(route.id)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 truncate text-xs text-[var(--dim)]">{summary}</p>
            </div>
          );
        })}
        {data.routes.length === 0 && (
          <p className="py-8 text-center text-sm text-[var(--dim)]">
            登録された経路はまだありません。
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------- 歩行学習 ----------------

function LearnView({
  data,
  activeRoute,
  onRecord,
  onDeleteLog,
}: {
  data: State;
  activeRoute: Route | null;
  onRecord: (segmentId: number, plannedMin: number, actualMin: number) => void;
  onDeleteLog: (id: number) => void;
}) {
  const walkSegs = useMemo(
    () => activeRoute?.segments.filter((s) => s.type === "walk") ?? [],
    [activeRoute],
  );
  const [selectedSegId, setSelectedSegId] = useState<number | null>(null);
  const selected: Segment | undefined =
    walkSegs.find((s) => s.id === selectedSegId) ?? walkSegs[0];
  const [manualMin, setManualMin] = useState("");
  const [timer, setTimer] = useState<{ segmentId: number; startedAt: number } | null>(
    null,
  );
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [timer]);

  if (!activeRoute) {
    return (
      <p className="py-12 text-center text-sm text-[var(--dim)]">
        経路を登録すると、徒歩区間の実績を記録してペースを学習できます。
      </p>
    );
  }

  const segmentLabel = (segId: number): string => {
    for (const r of data.routes) {
      const s = r.segments.find((x) => x.id === segId);
      if (s) return `${s.fromLabel} → ${s.toLabel}`;
    }
    return "徒歩区間";
  };
  const routeLogs = data.walkLogs.filter((l) => l.routeId === activeRoute.id);

  return (
    <div>
      <p className="text-sm text-[var(--dim)]">
        実際に歩いた時間を記録すると、区間ごとにあなたのペース（目安に対する比率）を学習し、発車案内の徒歩時間を補正します。対象経路:
        <span className="font-bold text-[var(--text)]"> {activeRoute.name}</span>
      </p>

      <div className="mt-3 space-y-2">
        {walkSegs.map((seg) => {
          const ratio =
            seg.learnedWalkMin != null && seg.baseWalkMin
              ? seg.learnedWalkMin / seg.baseWalkMin
              : null;
          return (
            <div
              key={seg.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <p className="flex items-center gap-2 text-sm font-black">
                <WalkIcon size={16} className="text-[var(--warn)]" />
                {seg.fromLabel} → {seg.toLabel}
              </p>
              <p className="tnum mt-1 text-sm text-[var(--dim)]">
                目安 {seg.baseWalkMin ?? "?"}分
                {seg.learnedWalkMin != null ? (
                  <>
                    {" → "}学習値{" "}
                    <span className="font-bold text-[var(--text)]">
                      {seg.learnedWalkMin}分
                    </span>
                    （{seg.walkSamples}件の実績
                    {ratio != null &&
                      `・ペース目安の${ratio.toFixed(2)}倍`}
                    ）
                  </>
                ) : (
                  <>（実績はまだありません）</>
                )}
              </p>
            </div>
          );
        })}
        {walkSegs.length === 0 && (
          <p className="text-sm text-[var(--dim)]">この経路には徒歩区間がありません。</p>
        )}
      </div>

      {selected && (
        <section
          aria-label="歩行記録"
          className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <h2 className="text-sm font-black">歩いた時間を記録</h2>
          {walkSegs.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {walkSegs.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  aria-pressed={selected.id === seg.id}
                  onClick={() => setSelectedSegId(seg.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                    selected.id === seg.id
                      ? "border-[var(--warn)] bg-[#3d2c07] text-[#fbbf24]"
                      : "border-[var(--border)] text-[var(--dim)]"
                  }`}
                >
                  {seg.fromLabel} → {seg.toLabel}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 rounded-lg bg-[var(--bg)] p-3">
            {timer && timer.segmentId === selected.id ? (
              <div className="flex items-center justify-between gap-2">
                <p className="tnum text-2xl font-bold">
                  {fmtCountdown((nowMs - timer.startedAt) / 1000)}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-black text-[#0b2013]"
                    onClick={() => {
                      const actual =
                        Math.round(((Date.now() - timer.startedAt) / 60000) * 10) / 10;
                      const planned = walkMinutes(selected) ?? actual;
                      if (actual >= 0.1) onRecord(selected.id, planned, actual);
                      setTimer(null);
                    }}
                  >
                    到着して記録
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border)] px-3 py-2 text-sm font-bold"
                    onClick={() => setTimer(null)}
                  >
                    中止
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="w-full rounded-md border border-[var(--accent)] px-3 py-2.5 text-sm font-black text-[#4ade80]"
                onClick={() => {
                  setNowMs(Date.now());
                  setTimer({ segmentId: selected.id, startedAt: Date.now() });
                }}
              >
                ストップウォッチで計測開始（{selected.fromLabel} を出発）
              </button>
            )}
            <div className="mt-3 flex items-center gap-2">
              <label className="text-xs text-[var(--dim)]" htmlFor="manual-walk-min">
                手入力（分）
              </label>
              <input
                id="manual-walk-min"
                aria-label="実際に歩いた分数"
                type="number"
                min={0.5}
                step={0.5}
                className="tnum w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
                value={manualMin}
                onChange={(e) => setManualMin(e.target.value)}
              />
              <button
                type="button"
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-bold"
                onClick={() => {
                  const n = Number(manualMin);
                  const planned = walkMinutes(selected);
                  if (Number.isFinite(n) && n >= 0.1 && planned != null) {
                    onRecord(selected.id, planned, n);
                    setManualMin("");
                  }
                }}
              >
                記録する
              </button>
            </div>
          </div>
        </section>
      )}

      <section aria-label="最近の歩行記録" className="mt-4">
        <h2 className="text-xs font-bold text-[var(--dim)]">最近の記録</h2>
        <div className="mt-1.5 space-y-1.5">
          {routeLogs.slice(0, 10).map((log) => (
            <div
              key={log.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              <span>
                {segmentLabel(log.segmentId)}
                <span className="tnum ml-2 text-[var(--dim)]">
                  予定 {log.plannedMin}分 → 実際 {log.actualMin}分
                </span>
              </span>
              <span className="flex items-center gap-2 text-xs text-[var(--dim)]">
                {new Date(log.recordedAt).toLocaleString("ja-JP", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                <button
                  type="button"
                  aria-label="この記録を削除"
                  className="text-[var(--danger)]"
                  onClick={() => onDeleteLog(log.id)}
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            </div>
          ))}
          {routeLogs.length === 0 && (
            <p className="text-sm text-[var(--dim)]">記録はまだありません。</p>
          )}
        </div>
      </section>
    </div>
  );
}
