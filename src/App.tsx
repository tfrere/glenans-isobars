import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Box,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import AirIcon from "@mui/icons-material/Air";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useIsobars } from "./useIsobars";
import { useHistory, frameToGrid } from "./useHistory";
import IsobarMap from "./IsobarMap";
import Timeline, { type SpanMode } from "./Timeline";
import type { IsobarGrid } from "./api";

// Index of the grid sample nearest to the Glénans.
function glenansIndex(grid: IsobarGrid): number {
  const { bbox, nx, ny, glenans } = grid;
  const i = Math.round(
    ((glenans.lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * (nx - 1),
  );
  const j = Math.round(
    ((bbox.latMax - glenans.lat) / (bbox.latMax - bbox.latMin)) * (ny - 1),
  );
  return (
    Math.min(Math.max(j, 0), ny - 1) * nx + Math.min(Math.max(i, 0), nx - 1)
  );
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO",
];
const cardinal = (deg: number) => COMPASS[Math.round(deg / 22.5) % 16];

// "2025-06-01" -> "1 juin 2025"
function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Frosted-glass floating panel, readable over the white chart.
const panelSx = {
  bgcolor: "rgba(255,255,255,0.78)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  border: "1px solid rgba(0,0,0,0.12)",
  borderRadius: 2,
  boxShadow: "0 6px 24px rgba(0,0,0,0.10)",
} as const;

// Toggle groups stretch to full width on mobile (equal-width buttons) and stay
// compact/auto on desktop.
const groupSx = {
  width: { xs: "100%", sm: "auto" },
  "& .MuiToggleButtonGroup-grouped": { flex: { xs: 1, sm: "none" } },
} as const;

function Overlay({
  children,
  sx,
}: {
  children: ReactNode;
  sx?: object;
}) {
  return (
    <Box sx={{ position: "absolute", zIndex: 10, ...sx }}>{children}</Box>
  );
}

function Legend() {
  const item = (svg: ReactNode, label: string) => (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
      {svg}
      <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
        {label}
      </Typography>
    </Stack>
  );
  return (
    <Stack
      direction="row"
      spacing={1.75}
      sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 0.5, color: "text.secondary" }}
    >
      {item(
        <svg width={24} height={8} aria-hidden>
          <line x1={0} y1={4} x2={24} y2={4} stroke="#111" strokeWidth={1.4} />
        </svg>,
        "isobares",
      )}
      <Typography variant="caption">
        <b style={{ color: "#111" }}>H</b>/<b style={{ color: "#111" }}>L</b>{" "}
        haute/basse
      </Typography>
      {item(
        <svg width={32} height={12} aria-hidden>
          <line x1={0} y1={9} x2={32} y2={9} stroke="#111" strokeWidth={1.6} />
          <path d="M6,9 L11,9 L8.5,3 Z" fill="#111" />
          <path d="M19,9 L24,9 L21.5,3 Z" fill="#111" />
        </svg>,
        "front froid",
      )}
      {item(
        <svg width={32} height={12} aria-hidden>
          <line x1={0} y1={9} x2={32} y2={9} stroke="#111" strokeWidth={1.6} />
          <path d="M6,9 A3,3 0 0 1 12,9 Z" fill="#111" />
          <path d="M19,9 A3,3 0 0 1 25,9 Z" fill="#111" />
        </svg>,
        "front chaud",
      )}
      {item(
        <svg width={34} height={12} aria-hidden>
          <line x1={0} y1={9} x2={34} y2={9} stroke="#111" strokeWidth={1.6} />
          <path d="M5,9 L10,9 L7.5,3 Z" fill="#111" />
          <path d="M16,9 A3,3 0 0 1 22,9 Z" fill="#111" />
          <path d="M26,9 L31,9 L28.5,3 Z" fill="#111" />
        </svg>,
        "occlus",
      )}
      {item(
        <svg width={26} height={8} aria-hidden>
          <line
            x1={0}
            y1={4}
            x2={26}
            y2={4}
            stroke="#111"
            strokeWidth={1.4}
            strokeDasharray="2 4"
          />
        </svg>,
        "thalweg",
      )}
    </Stack>
  );
}

// Centered overlay used for the loading / error / building states.
function StatusOverlay({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 5,
      }}
    >
      <Box sx={{ ...panelSx, px: 4, py: 3, textAlign: "center", maxWidth: 360 }}>
        {children}
      </Box>
    </Box>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between" }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: "text.primary" }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

export default function App() {
  // Wind field and fronts are always drawn; the toggles were removed.
  const showWind = true;
  const showFronts = true;
  const [mode, setMode] = useState<"live" | "history">(() =>
    new URLSearchParams(window.location.search).get("mode") === "live"
      ? "live"
      : "history",
  );

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [span, setSpan] = useState<SpanMode>("year");

  const live = useIsobars(mode === "live");
  const hist = useHistory();

  // Open on the most recent frame (today) rather than a year ago, so the
  // week / month windows land on the current period instead of June 2025.
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && hist.status === "ready" && hist.data) {
      seeded.current = true;
      setIndex(hist.data.dates.length - 1);
    }
  }, [hist.status, hist.data]);

  // Space bar toggles playback of the timeline (history mode only). Ignored
  // when a form control is focused so it doesn't double-fire with a button or
  // hijack typing, and preventDefault stops the page from scrolling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (mode !== "history" || hist.status !== "ready") return;
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (["INPUT", "TEXTAREA", "BUTTON", "SELECT"].includes(tag)) return;
      e.preventDefault();
      setPlaying((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, hist.status]);

  // Resolve the active grid + a human date label for the current mode.
  let grid: IsobarGrid | null = null;
  let dateLabel = "";
  let sourceLabel = "";
  let bigDate = "";
  let timeLabel = "";
  if (mode === "live") {
    grid = live.data;
    sourceLabel = "Open-Meteo · ECMWF IFS 0.25°";
    dateLabel = grid?.updatedAt ? `${grid.updatedAt.replace("T", " ")} UTC` : "-";
    if (grid?.updatedAt) {
      const dt = new Date(`${grid.updatedAt}Z`);
      bigDate = dt.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      timeLabel = `${dt.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      })} UTC · temps réel`;
    }
  } else if (hist.status === "ready" && hist.data) {
    const safe = Math.min(index, hist.data.dates.length - 1);
    grid = frameToGrid(hist.data, safe);
    sourceLabel = hist.data.source;
    dateLabel = `${hist.data.dates[safe]} · 12:00 UTC`;
    bigDate = longDate(hist.data.dates[safe]);
    timeLabel = "12:00 UTC · archive ERA5";
  }

  const gi = grid ? glenansIndex(grid) : 0;

  // Provenance + method + legend, surfaced through an (i) tooltip on the title
  // card instead of a permanent panel, to keep the chart uncluttered.
  const provenance = grid ? (
    <Box sx={{ minWidth: 252 }}>
      <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, mb: 0.75 }}>
        Pression au niveau de la mer (MSLP)
      </Typography>
      <Stack spacing={0.4}>
        <InfoRow label="Données" value={sourceLabel} />
        <InfoRow label={mode === "live" ? "Échéance" : "Date"} value={dateLabel} />
        <InfoRow label="Grille" value={`${grid.nx}×${grid.ny} · iso ${grid.step} hPa`} />
        <InfoRow
          label="Fronts"
          value={
            <>
              θ<sub>e</sub> 850 hPa · TFP Hewson
            </>
          }
        />
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 0.75, lineHeight: 1.4 }}
      >
        Détection objective : θ<sub>e</sub> à 850 hPa, paramètre frontal
        thermique de Hewson (TFP=0 dans la zone barocline), classification
        froid/chaud par advection, occlus quand le vent est quasi parallèle au
        front. Thalwegs : axes de courbure cyclonique de la MSLP.
      </Typography>
      <Divider sx={{ my: 1 }} />
      <Legend />
    </Box>
  ) : null;

  return (
    <Box sx={{ position: "fixed", inset: 0, overflow: "hidden", bgcolor: "#fff" }}>
      {grid && (
        <IsobarMap grid={grid} showWind={showWind} showFronts={showFronts} />
      )}

      {/* Loading / error / building states */}
      {mode === "live" && live.loading && (
        <StatusOverlay>
          <CircularProgress size={28} />
          <Typography sx={{ mt: 2 }} color="text.secondary">
            Chargement des données de pression…
          </Typography>
        </StatusOverlay>
      )}
      {mode === "live" && live.error && !live.data && (
        <StatusOverlay>
          <Typography color="error">Erreur de chargement</Typography>
          <Typography variant="caption" color="text.secondary">
            {live.error}
          </Typography>
        </StatusOverlay>
      )}
      {mode === "history" && hist.status !== "ready" && (
        <StatusOverlay>
          {hist.status === "error" ? (
            <>
              <Typography color="error">Erreur de l'historique</Typography>
              <Typography variant="caption" color="text.secondary">
                {hist.error}
              </Typography>
            </>
          ) : (
            <>
              <Typography color="text.secondary" sx={{ mb: 1.5 }}>
                Construction de la timeline (1 an d'archives ERA5)…
              </Typography>
              <LinearProgress
                variant={hist.progress > 0 ? "determinate" : "indeterminate"}
                value={Math.round(hist.progress * 100)}
              />
              <Typography variant="caption" color="text.secondary">
                {Math.round(hist.progress * 100)}%
              </Typography>
            </>
          )}
        </StatusOverlay>
      )}

      {/* Top-left: title + live readout at the Glénans. Fixed width on desktop
          so it doesn't resize with content; caps at the viewport on mobile. */}
      <Overlay sx={{ top: 16, left: 16, right: 16 }}>
        <Box sx={{ ...panelSx, px: 1.75, py: 1.25, width: 300, maxWidth: "100%" }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <AirIcon sx={{ fontSize: 22, color: "text.primary" }} />
            <Box sx={{ flexGrow: 1 }}>
              <Typography sx={{ fontSize: "1.05rem", fontWeight: 700, lineHeight: 1.1, letterSpacing: "-0.02em" }}>
                Isobares · Glénans
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Pression mer · Europe
              </Typography>
            </Box>
            {provenance && (
              <Tooltip
                title={provenance}
                placement="bottom-start"
                slotProps={{
                  tooltip: {
                    sx: {
                      ...panelSx,
                      color: "text.primary",
                      px: 1.75,
                      py: 1.5,
                      maxWidth: 340,
                    },
                  },
                }}
              >
                <IconButton size="small" sx={{ ml: 0.5, color: "text.secondary" }} aria-label="Informations sur les données">
                  <InfoOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
          {grid && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography
                sx={{
                  fontSize: "1.3rem",
                  fontWeight: 700,
                  lineHeight: 1.1,
                  letterSpacing: "-0.02em",
                }}
              >
                {bigDate || "-"}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {timeLabel}
              </Typography>
              <Typography sx={{ mt: 0.5, fontVariantNumeric: "tabular-nums", fontSize: "0.85rem" }}>
                <Box component="span" sx={{ color: "text.secondary" }}>Glénans</Box>{" "}
                <b>{grid.values[gi].toFixed(0)} hPa</b>
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {" "}· vent {grid.windSpeed[gi].toFixed(0)} kt{" "}
                  {cardinal(grid.windDirection[gi])}
                </Box>
              </Typography>
            </>
          )}
        </Box>
      </Overlay>

      {/* Bottom: unified control bar. On desktop the mode + span toggles sit
          inline on the left and the timeline fills the rest of the same row;
          on mobile everything stacks into full-width rows. */}
      <Overlay sx={{ bottom: 16, left: 16, right: 16 }}>
        <Box
          sx={{
            ...panelSx,
            px: 1.5,
            py: 1.25,
            display: "flex",
            flexDirection: { xs: "column", sm: "row" },
            alignItems: { xs: "stretch", sm: "center" },
            gap: 1.5,
          }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mode}
            onChange={(_, v) => v && setMode(v)}
            sx={groupSx}
          >
            <ToggleButton value="history">Historique</ToggleButton>
            <ToggleButton value="live">Direct</ToggleButton>
          </ToggleButtonGroup>

          {mode === "history" && hist.status === "ready" && hist.data && (
            <>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={span}
                onChange={(_, v) => v && setSpan(v as SpanMode)}
                sx={groupSx}
              >
                <ToggleButton value="week">Semaine</ToggleButton>
                <ToggleButton value="month">Mois</ToggleButton>
                <ToggleButton value="year">Année</ToggleButton>
              </ToggleButtonGroup>
              <Box sx={{ flexGrow: 1, width: "100%", minWidth: 0 }}>
                <Timeline
                  dates={hist.data.dates}
                  index={Math.min(index, hist.data.dates.length - 1)}
                  span={span}
                  playing={playing}
                  onIndexChange={setIndex}
                  onPlayToggle={() => setPlaying((p) => !p)}
                  onStop={() => setPlaying(false)}
                />
              </Box>
            </>
          )}
        </Box>
      </Overlay>
    </Box>
  );
}
