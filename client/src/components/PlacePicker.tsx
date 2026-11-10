// Place picker: register a point by spot name / address search, by
// tapping a pin on the map, or from the current GPS position.
// Raw latitude/longitude are never shown or typed — they stay internal.

import { useEffect, useRef, useState } from "react";
import "../assets/hatch-maps.js";
import "../assets/hatch-maps.css";
import { api } from "../api";
import { mountMap, type PlaceRef } from "../map_helpers.mjs";
import { CrosshairIcon, PinIcon } from "./icons";

export interface PlaceValue {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export const emptyPlace = (name = ""): PlaceValue => ({
  name,
  address: "",
  lat: null,
  lng: null,
});

interface Candidate {
  name: string;
  address: string;
  lat: number;
  lng: number;
  kind: string;
}

type MapHandle = {
  selectPlace?: (index: number) => void;
  remove?: () => void;
  destroy?: () => void;
} | null;

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]";

export function PlacePicker({
  label,
  namePlaceholder,
  value,
  onChange,
}: {
  label: string;
  namePlaceholder?: string;
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [gpsNote, setGpsNote] = useState<string | null>(null);

  const registered = value.lat != null && value.lng != null;

  const doSearch = async () => {
    const q = (query || value.name).trim();
    if (!q || searching) return;
    setSearching(true);
    try {
      const res = await api.searchPlaces({ query: q });
      setCandidates(res.places);
      setSearched(true);
    } catch {
      setCandidates([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const pickCandidate = (c: Candidate) => {
    onChange({
      name: c.name || value.name,
      address: c.address,
      lat: c.lat,
      lng: c.lng,
    });
  };

  const useCurrentPosition = () => {
    if (!("geolocation" in navigator)) {
      setGpsNote("この端末では位置情報が使えません");
      return;
    }
    setGpsNote("現在地を取得中…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        void api
          .reverseGeocode({ lat, lng })
          .then((rev) => {
            onChange({
              name: rev.name || value.name,
              address: rev.address ?? "",
              lat,
              lng,
            });
            setGpsNote(null);
          })
          .catch(() => {
            onChange({ name: value.name, address: "", lat, lng });
            setGpsNote(null);
          });
      },
      () => setGpsNote("位置情報を取得できませんでした"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  // Map pins: search candidates (numbered) + the registered point (◎).
  const mapPlaces: PlaceRef[] = [
    ...candidates.map((c) => ({
      label: c.name,
      address: c.address,
      lat: c.lat,
      lng: c.lng,
    })),
    ...(registered
      ? [{ label: value.name || "登録した地点", lat: value.lat as number, lng: value.lng as number }]
      : []),
  ];
  const placesKey = mapPlaces
    .map((p) => `${p.label}:${p.lat},${p.lng}`)
    .join("|");
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MapHandle>(null);
  const candidatesRef = useRef<Candidate[]>([]);
  candidatesRef.current = candidates;

  useEffect(() => {
    if (!mapOpen) return;
    setMapUnavailable(false);
    let cancelled = false;
    const g = globalThis as unknown as { HatchMaps?: unknown };
    if (!g.HatchMaps || !containerRef.current) {
      setMapUnavailable(true);
      return;
    }
    try {
      const places: PlaceRef[] = [
        ...candidatesRef.current.map((c) => ({
          label: c.name,
          address: c.address,
          lat: c.lat,
          lng: c.lng,
        })),
      ];
      const handle = mountMap(
        containerRef.current,
        {
          places,
          baseStyle: "dark",
          marker: (_place: PlaceRef, index: number, selected: boolean) =>
            `<div class="pin${selected ? " pin--on" : ""}">${index + 1}</div>`,
          onSelectPlace: (index: number | null) => {
            if (index == null) return;
            const c = candidatesRef.current[index];
            if (c) {
              onChange({
                name: c.name,
                address: c.address,
                lat: c.lat,
                lng: c.lng,
              });
            }
          },
        },
        () => {
          if (!cancelled) setMapUnavailable(true);
        },
      ) as MapHandle;
      handleRef.current = handle;
      if (!handle) setMapUnavailable(true);
    } catch {
      setMapUnavailable(true);
    }
    return () => {
      cancelled = true;
      try {
        handleRef.current?.destroy?.();
        handleRef.current?.remove?.();
      } catch {
        // ignore cleanup errors
      }
      handleRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapOpen, placesKey]);

  return (
    <div>
      <span className="mb-1 block text-xs font-bold text-[var(--dim)]">
        {label}
      </span>
      <input
        aria-label={label}
        className={inputCls}
        value={value.name}
        onChange={(e) =>
          onChange({ ...value, name: e.target.value })
        }
        placeholder={namePlaceholder ?? "例: 自宅"}
      />
      {registered ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="rounded bg-[#123c26] px-1.5 py-0.5 font-bold text-[#4ade80]">
            <PinIcon size={11} className="mr-0.5 inline" />
            地点登録済み
          </span>
          {value.address && (
            <span className="min-w-0 flex-1 truncate text-[var(--dim)]">
              {value.address}
            </span>
          )}
          <button
            type="button"
            className="text-[var(--dim)] underline"
            onClick={() =>
              onChange({ name: value.name, address: "", lat: null, lng: null })
            }
          >
            解除
          </button>
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-[var(--dim)]">
          スポット名や住所で探すと、その地点を登録できます（方向の自動判定や現在地補正に使います）。
        </p>
      )}

      <div className="mt-2 flex gap-1.5">
        <input
          aria-label={`${label}をスポット名・住所で探す`}
          className={`${inputCls} min-w-0 flex-1`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void doSearch();
            }
          }}
          placeholder="例: 金閣寺 / 京都市北区金閣寺町1"
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-[var(--accent-dim)] px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
          disabled={searching}
          onClick={() => void doSearch()}
        >
          {searching ? "検索中" : "探す"}
        </button>
      </div>

      {candidates.length > 0 && (
        <ul className="mt-1.5 space-y-1" aria-label="地点の候補">
          {candidates.map((c, i) => {
            const isPicked =
              registered && value.lat === c.lat && value.lng === c.lng;
            return (
              <li key={`${c.lat},${c.lng},${i}`}>
                <button
                  type="button"
                  onClick={() => pickCandidate(c)}
                  className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left ${
                    isPicked
                      ? "border-[var(--accent)] bg-[#123c26]"
                      : "border-[var(--border)] bg-[var(--bg)]"
                  }`}
                >
                  <span className="mt-0.5 shrink-0 rounded bg-[var(--surface2)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--dim)]">
                    {i + 1}. {c.kind}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold">
                      {c.name}
                    </span>
                    <span className="block truncate text-xs text-[var(--dim)]">
                      {c.address}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {searched && candidates.length === 0 && !searching && (
        <p className="mt-1.5 text-xs text-[var(--warn)]">
          候補が見つかりませんでした。住所を詳しく入力するか、地図・現在地から登録してください。
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-expanded={mapOpen}
          className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold"
          onClick={() => setMapOpen((o) => !o)}
        >
          {mapOpen ? "地図を閉じる" : "地図で選ぶ"}
        </button>
        <button
          type="button"
          className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-bold"
          onClick={useCurrentPosition}
        >
          <CrosshairIcon size={12} className="mr-0.5 inline" />
          現在地を登録
        </button>
      </div>
      {gpsNote && (
        <p className="mt-1 text-xs text-[var(--warn)]">{gpsNote}</p>
      )}

      {mapOpen && (
        <div className="mt-2">
          {mapUnavailable ? (
            <p className="rounded-md border border-[var(--border)] px-3 py-2.5 text-xs text-[var(--dim)]">
              地図を表示できませんでした。上の候補リストから地点を選んでください。
            </p>
          ) : candidates.length === 0 ? (
            <p className="rounded-md border border-[var(--border)] px-3 py-2.5 text-xs text-[var(--dim)]">
              先にスポット名や住所で探すと、候補が地図にピンで表示されます。ピンをタップするとその地点を登録できます。
            </p>
          ) : (
            <>
              <div
                ref={containerRef}
                className="h-[260px] w-full overflow-hidden rounded-md border border-[var(--border)]"
                aria-label={`${label}の地図`}
              />
              <p className="mt-1 text-xs text-[var(--dim)]">
                番号ピンは検索候補です。ピンをタップすると、その地点を登録します。
              </p>
              <p className="mt-1 text-right text-[11px] text-[var(--dim)]">
                <a
                  href="https://www.facebook.com/maps/attribution_terms"
                  target="_blank"
                  rel="noopener"
                  className="underline"
                >
                  © OpenStreetMap contributors, Map Data Legal Notices
                </a>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
