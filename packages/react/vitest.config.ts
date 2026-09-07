/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// First renderer setup outside `apps/studio` (design.md D8, tasks.md 5a.2).
// This package builds with plain `tsc` (see package.json's `build` script);
// `@vitejs/plugin-react` is a TEST-ONLY dependency here, used solely so
// Vitest can transform `.tsx` test files under jsdom. It never touches the
// package's real build output.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
  },
});
