/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    // Workspace packages reaching the WASM compiler must not be pre-bundled:
    // esbuild would inline the `new URL(...wasm, import.meta.url)` asset
    // reference and break it. Vite serves them from source instead.
    exclude: ["@indigodb/core", "@indigodb/parser", "@indigodb/compiler"],
  },
  server: {
    port: 5555,
  },
  // Component tests share this config (not a separate vitest.config.ts) so
  // the `@` alias and the WASM optimizeDeps.exclude rule stay single-sourced
  // instead of duplicated and prone to drift between build and test.
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: false,
  },
});
