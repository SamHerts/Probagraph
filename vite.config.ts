import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the build works from any sub-path (and inside Tauri).
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
