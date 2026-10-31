import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/openapi/schreiben.openapi.ts"], environment: "node" } });
