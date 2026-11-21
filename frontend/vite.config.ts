import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI calls relative /api/... URLs; Vite forwards them to the FastAPI server. In Docker API_URL is
// http://api:8000, when running `npm run dev` on a laptop it falls back to localhost.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.API_URL ?? "http://localhost:8000" },
  },
});
