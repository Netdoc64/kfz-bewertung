import { rauchtest } from "./rauchtest.mjs";

const limit = Number(process.env.RAUCHTEST_ZEITLIMIT_MS);
const { ok, befunde } = await rauchtest(process.argv[2], limit > 0 ? { zeitlimitMs: limit } : {});
for (const b of befunde) console.log(`${b.stufe === "ok" ? "OK " : "FEHLER "} ${b.text}`);
console.log(ok ? "Rauchtest bestanden." : "Rauchtest FEHLGESCHLAGEN.");
// exitCode statt exit(): unter Windows bricht exit() mit offenen fetch-Handles in libuv ab.
process.exitCode = ok ? 0 : 1;
