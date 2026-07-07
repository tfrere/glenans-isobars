import { createTheme } from "@mui/material/styles";

// Light, monochrome theme to match the Met Office "Black and White" surface
// pressure charts: white surfaces, near-black ink, neutral greys.
export const theme = createTheme({
  palette: {
    mode: "light",
    background: {
      default: "#f4f4f4",
      paper: "#ffffff",
    },
    primary: { main: "#1a1a1a" },
    text: {
      primary: "#1a1a1a",
      secondary: "#5f6368",
    },
    divider: "#d7d7d7",
  },
  typography: {
    fontFamily: 'system-ui, "Segoe UI", Roboto, sans-serif',
    h1: { fontSize: "1.6rem", fontWeight: 700, letterSpacing: "-0.02em" },
  },
  shape: { borderRadius: 8 },
});
