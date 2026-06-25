import { useEffect, useState } from "react";
import type { BBox, IsobarGrid } from "./api";

export interface HistoryFrame {
  values: number[];
  windSpeed: number[];
  windDirection: number[];
}

export interface HistoryReady {
  status: "ready";
  bbox: BBox;
  nx: number;
  ny: number;
  step: number;
  glenans: { name: string; lat: number; lon: number };
  source: string;
  dates: string[];
  frames: HistoryFrame[];
}

export interface HistoryPending {
  status: "idle" | "building" | "error";
  progress: number;
  error: string | null;
}

type HistoryResponse = HistoryReady | HistoryPending;

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface State {
  data: HistoryReady | null;
  status: HistoryResponse["status"];
  progress: number;
  error: string | null;
}

export function useHistory(): State {
  const [state, setState] = useState<State>({
    data: null,
    status: "idle",
    progress: 0,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/history`);
        const json = (await res.json()) as HistoryResponse;
        if (!alive) return;
        if (json.status === "ready") {
          setState({ data: json, status: "ready", progress: 1, error: null });
          return; // stop polling
        }
        setState({
          data: null,
          status: json.status,
          progress: json.progress ?? 0,
          error: json.error ?? null,
        });
      } catch {
        if (!alive) return;
        setState((s) => ({ ...s, status: "building" }));
      }
      timer = setTimeout(poll, 3000);
    };

    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  return state;
}

// Build an IsobarGrid (the shape IsobarMap expects) from a single frame.
export function frameToGrid(h: HistoryReady, idx: number): IsobarGrid {
  const f = h.frames[idx];
  let min = Infinity;
  let max = -Infinity;
  for (const v of f.values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    bbox: h.bbox,
    nx: h.nx,
    ny: h.ny,
    step: h.step,
    glenans: h.glenans,
    model: h.source,
    values: f.values,
    windSpeed: f.windSpeed,
    windDirection: f.windDirection,
    min,
    max,
    updatedAt: h.dates[idx],
  };
}
