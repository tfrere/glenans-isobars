import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, // reserved dev port (unique per project)
    // In dev, proxy API calls to the FastAPI backend (python server/app.py).
    proxy: {
      "/api": "http://127.0.0.1:7860",
    },
  },
});
