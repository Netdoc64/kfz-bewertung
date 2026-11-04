import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      // Dünner Prozess-Kleber (spawn, process.exit); die Logik liegt in einrichten.ts.
      exclude: ["src/**/*.test.ts", "src/*-cli.ts"],
      thresholds: { lines: 85, branches: 75 },
    },
  },
});
