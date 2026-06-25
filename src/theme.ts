import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#070a16",
      paper: "#0f1424",
    },
    primary: { main: "#7dd3fc" },
    text: {
      primary: "#e2e8f0",
      secondary: "#94a3b8",
    },
  },
  typography: {
    fontFamily: 'system-ui, "Segoe UI", Roboto, sans-serif',
    h1: { fontSize: "1.6rem", fontWeight: 700, letterSpacing: "-0.02em" },
  },
  shape: { borderRadius: 12 },
});
