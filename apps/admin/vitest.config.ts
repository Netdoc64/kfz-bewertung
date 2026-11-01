import { defineConfig } from "vitest/config";

// Eigene Konfiguration, damit vitest die Vite-Build-Konfiguration nicht mitliest.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      thresholds: { lines: 85, branches: 75 },
    },
  },
});
