import { defineConfig } from "vite";

// Settings Tauri expects: fixed port, don't hide Rust errors, no outside access.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2021", outDir: "dist" },
});
