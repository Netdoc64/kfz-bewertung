import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { einrichten, EinrichtenFehler, type Ausfuehren } from "./einrichten.ts";

const wurzel = fileURLToPath(new URL("../../../", import.meta.url));
const konfigPfad = fileURLToPath(new URL("../../../apps/api/wrangler.jsonc", import.meta.url));

const ausfuehren: Ausfuehren = (args) =>
  new Promise((aufloesen) => {
    const p = spawn("npx", ["wrangler", ...args], { cwd: wurzel, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => aufloesen({ code: 127, stdout, stderr: String(e) }));
    p.on("close", (code) => aufloesen({ code: code ?? 1, stdout, stderr }));
  });

try {
  await einrichten(readFileSync(konfigPfad, "utf8"), ausfuehren, (z) => console.log(z));
} catch (e) {
  console.error(e instanceof EinrichtenFehler ? `Abbruch: ${e.message}` : e);
  process.exit(1);
}
