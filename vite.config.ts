/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Edge function logic that doesn't touch Deno APIs is tested here too.
    include: ["src/**/*.test.{ts,tsx}", "supabase/functions/**/*.test.ts"],
  },
});
