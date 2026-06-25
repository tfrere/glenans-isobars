import { useState } from "react";
import {
  AppBar,
  Box,
  Chip,
  CircularProgress,
  Container,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import AirIcon from "@mui/icons-material/Air";
import { useIsobars } from "./useIsobars";
import { useHistory, frameToGrid } from "./useHistory";
import IsobarMap, { pressureColor } from "./IsobarMap";
import Timeline from "./Timeline";
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
  const ci = Math.min(Math.max(i, 0), nx - 1);
  const cj = Math.min(Math.max(j, 0), ny - 1);
  return cj * nx + ci;
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO",
];

function cardinal(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16];
}

function Legend() {
  const ticks = [992, 1000, 1008, 1013, 1020, 1028, 1036];
  return (
    <Stack direction="row" spacing={0} sx={{ alignItems: "center" }}>
      <Box
        sx={{
          display: "flex",
          height: 12,
          borderRadius: 1,
          overflow: "hidden",
          width: 200,
        }}
      >
        {ticks.map((p) => (
          <Box
            key={p}
            sx={{ flex: 1, backgroundColor: pressureColor(p) }}
            title={`${p} hPa`}
          />
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
        basse ← pression → haute (hPa)
      </Typography>
    </Stack>
  );
}

function GlenansChips({ grid }: { grid: IsobarGrid }) {
  const idx = glenansIndex(grid);
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}
    >
      <Chip
        label={`${grid.values[idx].toFixed(0)} hPa aux Glénans`}
        color="primary"
        variant="outlined"
      />
      <Chip
        label={`vent ${grid.windSpeed[idx].toFixed(0)} kt ${cardinal(
          grid.windDirection[idx],
        )}`}
        size="small"
        variant="outlined"
      />
    </Stack>
  );
}

function LiveView({ showWind }: { showWind: boolean }) {
  const { data, loading, error } = useIsobars();

  if (loading) {
    return (
      <Stack
        spacing={0}
        sx={{ py: 10, alignItems: "center", justifyContent: "center" }}
      >
        <CircularProgress />
        <Typography sx={{ mt: 2 }} color="text.secondary">
          Chargement des données de pression…
        </Typography>
      </Stack>
    );
  }
  if (error || !data) {
    return (
      <Stack spacing={1} sx={{ py: 8, alignItems: "center" }}>
        <Typography color="error">Erreur de chargement</Typography>
        <Typography variant="caption" color="text.secondary">
          {error}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
      >
        <GlenansChips grid={data} />
        <Legend />
      </Stack>
      <IsobarMap grid={data} showWind={showWind} />
      <Typography variant="caption" color="text.secondary">
        Échéance modèle : {data.updatedAt || "-"} · isobares tous les {data.step}{" "}
        hPa · grille {data.nx}×{data.ny}
      </Typography>
    </Stack>
  );
}

function HistoryView({ showWind }: { showWind: boolean }) {
  const hist = useHistory();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  if (hist.status !== "ready" || !hist.data) {
    const pct = Math.round(hist.progress * 100);
    return (
      <Stack spacing={2} sx={{ py: 8, alignItems: "center" }}>
        {hist.status === "error" ? (
          <>
            <Typography color="error">
              Erreur de construction de l'historique
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {hist.error}
            </Typography>
          </>
        ) : (
          <>
            <Typography color="text.secondary">
              Construction de la timeline (1 an d'archives ERA5)…
            </Typography>
            <Box sx={{ width: 280 }}>
              <LinearProgress
                variant={pct > 0 ? "determinate" : "indeterminate"}
                value={pct}
              />
            </Box>
            <Typography variant="caption" color="text.secondary">
              {pct}%
            </Typography>
          </>
        )}
      </Stack>
    );
  }

  const data = hist.data;
  const safeIndex = Math.min(index, data.dates.length - 1);
  const grid = frameToGrid(data, safeIndex);

  return (
    <Stack spacing={2}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
      >
        <GlenansChips grid={grid} />
        <Legend />
      </Stack>
      <IsobarMap grid={grid} showWind={showWind} />
      <Timeline
        dates={data.dates}
        index={safeIndex}
        playing={playing}
        onIndexChange={setIndex}
        onPlayToggle={() => setPlaying((p) => !p)}
      />
      <Typography variant="caption" color="text.secondary">
        Source : {data.source} · échantillon quotidien 12:00 UTC · {data.dates.length}{" "}
        jours · grille {data.nx}×{data.ny}
      </Typography>
    </Stack>
  );
}

export default function App() {
  const [showWind, setShowWind] = useState(true);
  const [mode, setMode] = useState<"live" | "history">("live");

  return (
    <Box sx={{ minHeight: "100vh", pb: 6 }}>
      <AppBar position="static" elevation={0} color="transparent">
        <Toolbar>
          <AirIcon sx={{ mr: 1.5, color: "primary.main" }} />
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h1" component="h1">
              Isobares · Glénans
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Pression au niveau de la mer · Atlantique Nord-Est
            </Typography>
          </Box>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mode}
            onChange={(_, v) => v && setMode(v)}
            sx={{ mr: 2 }}
          >
            <ToggleButton value="live">Direct</ToggleButton>
            <ToggleButton value="history">Historique</ToggleButton>
          </ToggleButtonGroup>
          <FormControlLabel
            control={
              <Switch
                checked={showWind}
                onChange={(e) => setShowWind(e.target.checked)}
                size="small"
              />
            }
            label="Vent"
            sx={{ mr: 1, color: "text.secondary" }}
          />
          {mode === "live" && (
            <Tooltip title="Rafraîchir">
              <span>
                <IconButton
                  onClick={() => window.location.reload()}
                  color="primary"
                >
                  <RefreshIcon />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ mt: 3 }}>
        <Paper
          variant="outlined"
          sx={{ p: 2, borderColor: "rgba(255,255,255,0.08)" }}
        >
          {mode === "live" ? (
            <LiveView showWind={showWind} />
          ) : (
            <HistoryView showWind={showWind} />
          )}
        </Paper>
      </Container>
    </Box>
  );
}
