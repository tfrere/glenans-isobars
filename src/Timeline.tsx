import { useEffect } from "react";
import { Box, IconButton, Slider, Stack, Typography } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";

interface Props {
  dates: string[];
  index: number;
  playing: boolean;
  onIndexChange: (i: number) => void;
  onPlayToggle: () => void;
}

const FRAME_MS = 140;

function formatDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function Timeline({
  dates,
  index,
  playing,
  onIndexChange,
  onPlayToggle,
}: Props) {
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      onIndexChange((index + 1) % dates.length);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, [playing, index, dates.length, onIndexChange]);

  // Build month tick marks for orientation.
  const marks = dates
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.slice(8, 10) === "01")
    .map(({ d, i }) => ({
      value: i,
      label: new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", {
        month: "short",
      }),
    }));

  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
      <IconButton onClick={onPlayToggle} color="primary" size="small">
        {playing ? <PauseIcon /> : <PlayArrowIcon />}
      </IconButton>
      <Box sx={{ flexGrow: 1, px: 1 }}>
        <Slider
          size="small"
          min={0}
          max={Math.max(dates.length - 1, 0)}
          value={index}
          marks={marks}
          onChange={(_, v) => onIndexChange(v as number)}
          aria-label="Date"
        />
      </Box>
      <Typography
        variant="body2"
        sx={{ minWidth: 150, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
      >
        {dates.length ? formatDate(dates[index]) : "-"}
      </Typography>
    </Stack>
  );
}
