import { useEffect } from "react";
import { Box, IconButton, Slider, Stack, useMediaQuery, useTheme } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

export type SpanMode = "week" | "month" | "year";

const SPAN_DAYS: Record<SpanMode, number> = { week: 7, month: 30, year: 365 };

interface Props {
  dates: string[];
  index: number;
  span: SpanMode;
  playing: boolean;
  onIndexChange: (i: number) => void;
  onPlayToggle: () => void;
  onStop: () => void;
}

const FRAME_MS = 140;

export default function Timeline({
  dates,
  index,
  span,
  playing,
  onIndexChange,
  onPlayToggle,
  onStop,
}: Props) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down("sm"));
  const total = dates.length;
  const block = Math.min(SPAN_DAYS[span], Math.max(total, 1));

  // Visible window. Pages are tiled from the END (today) backwards so the most
  // recent page is always a full week/month ending exactly on the last frame;
  // the leftover partial page (365 is not a multiple of 7 or 30) sits at the
  // very start of the year, far in the past, where it doesn't get in the way.
  let winStart: number;
  let winEnd: number;
  if (span === "year") {
    winStart = 0;
    winEnd = total - 1;
  } else {
    const last = total - 1;
    const page = Math.floor((last - index) / block);
    winEnd = last - page * block;
    winStart = Math.max(0, winEnd - block + 1);
  }

  // Playback plays the current window exactly once, then stops. Starting from
  // the last frame rewinds to the window start so a fresh press always shows a
  // full pass instead of doing nothing.
  useEffect(() => {
    if (!playing) return;
    if (index >= winEnd) {
      onIndexChange(winStart);
      return;
    }
    const id = setTimeout(() => {
      const next = index + 1;
      if (next >= winEnd) {
        onIndexChange(winEnd);
        onStop();
      } else {
        onIndexChange(next);
      }
    }, FRAME_MS);
    return () => clearTimeout(id);
  }, [playing, index, winStart, winEnd, onIndexChange, onStop]);

  // Tick marks adapted to the active window and screen size. On phones we
  // thin out the labels so they never overlap: fewer month labels in year
  // mode, and a coarser date step (with day-only labels) in week/month mode.
  const fmtMonth = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { month: "short" });
  const fmtDayMonth = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
    });
  const fmtDay = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "2-digit" });

  const marks: { value: number; label?: string }[] = [];
  if (span === "year") {
    // A dot on every month start; label every month (desktop) or every other
    // month (mobile) to keep them legible.
    let monthIdx = 0;
    for (let i = 0; i < total; i++) {
      if (dates[i].slice(8, 10) === "01") {
        const showLabel = !compact || monthIdx % 2 === 0;
        marks.push({ value: i, label: showLabel ? fmtMonth(dates[i]) : undefined });
        monthIdx++;
      }
    }
  } else {
    const everyN = span === "week" ? (compact ? 2 : 1) : compact ? 10 : 5;
    for (let i = winStart; i <= winEnd; i++) {
      if ((i - winStart) % everyN === 0) {
        marks.push({
          value: i,
          label: compact ? fmtDay(dates[i]) : fmtDayMonth(dates[i]),
        });
      }
    }
  }

  const paged = span !== "year";
  const gotoPrev = () => onIndexChange(Math.max(0, winStart - 1));
  const gotoNext = () => onIndexChange(Math.min(total - 1, winEnd + 1));

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <IconButton onClick={onPlayToggle} color="primary" size="small">
        {playing ? <PauseIcon /> : <PlayArrowIcon />}
      </IconButton>
      {paged && (
        <IconButton
          onClick={gotoPrev}
          size="small"
          disabled={winStart <= 0}
          aria-label="Période précédente"
        >
          <ChevronLeftIcon />
        </IconButton>
      )}
      <Box sx={{ flexGrow: 1, px: 1 }}>
        <Slider
          size="small"
          min={winStart}
          max={Math.max(winEnd, winStart)}
          value={Math.min(Math.max(index, winStart), winEnd)}
          marks={marks}
          onChange={(_, v) => onIndexChange(v as number)}
          aria-label="Date"
          sx={{
            "& .MuiSlider-markLabel": {
              fontSize: compact ? "0.6rem" : "0.7rem",
            },
          }}
        />
      </Box>
      {paged && (
        <IconButton
          onClick={gotoNext}
          size="small"
          disabled={winEnd >= total - 1}
          aria-label="Période suivante"
        >
          <ChevronRightIcon />
        </IconButton>
      )}
    </Stack>
  );
}
