import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { openapiText } from "./erzeuge.js";

// Läuft nur über `npm run openapi` (eigene Konfiguration, kein Workers-Pool), nie in `npm test`.
it("schreibt docs/openapi.json", () => {
  writeFileSync(fileURLToPath(new URL("../../../../docs/openapi.json", import.meta.url).href), openapiText());
});
