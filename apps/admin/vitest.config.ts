import { defineConfig } from "vitest/config";

// Eigene Konfiguration, damit vitest die Vite-Build-Konfiguration nicht mitliest.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
