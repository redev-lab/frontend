import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 백엔드(FastAPI :8000)로 프록시 — 프론트는 /report·/screen만 호출.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/report": "http://localhost:8000",
      "/screen": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
});
