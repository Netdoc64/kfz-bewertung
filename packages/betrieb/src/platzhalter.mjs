/**
 * Sperre gegen Platzhalter: bricht mit Exit 1 ab, solange die Ziel-Umgebung in
 * `apps/api/wrangler.jsonc` eine `database_id` aus Nullen (oder keine) oder leere
 * `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` hat. Oberste Ebene = Produktion, `env.<name>` sonst.
 * `entwicklung` ist ausgenommen. Liest nur, schreibt nie, kennt keine Werte.
 * Aufruf: node src/platzhalter.mjs [umgebung] [pfad-zur-wrangler.jsonc]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AUSGENOMMEN = new Set(["entwicklung"]);
const ACCESS_SCHLUESSEL = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"];

/** wrangler.jsonc: Kommentare und Komma vor `}`/`]` entfernen, Strings bleiben unberührt. */
export function parseJsonc(text) {
  let aus = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      aus += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const ende = text.indexOf("*/", i + 2);
      i = ende < 0 ? text.length : ende + 2;
    } else {
      aus += c;
      i++;
    }
  }
  return JSON.parse(aus.replace(/,(\s*[}\]])/g, "$1"));
}

const istNullId = (id) => typeof id !== "string" || /^[0\s-]*$/.test(id);
const istLeer = (wert) => typeof wert !== "string" || wert.trim() === "";

/**
 * Liefert die Verstöße für die Umgebung (leer = frei). `umgebung` "produktion" meint die
 * oberste Ebene. Unbekannte Umgebung ist selbst ein Verstoß.
 */
export function pruefe(konfig, umgebung = "produktion") {
  if (AUSGENOMMEN.has(umgebung)) return [];
  let ebene = konfig;
  if (umgebung !== "produktion") {
    ebene = konfig?.env?.[umgebung];
    if (!ebene) return [`Umgebung "${umgebung}" steht nicht in wrangler.jsonc (env.${umgebung}).`];
  }
  const probleme = [];
  const dbs = Array.isArray(ebene.d1_databases) ? ebene.d1_databases : [];
  if (dbs.length === 0) probleme.push(`${umgebung}: keine d1_databases eingetragen.`);
  for (const db of dbs) {
    if (istNullId(db?.database_id)) {
      probleme.push(`${umgebung}: database_id von "${db?.binding ?? "?"}" ist ein Platzhalter (Nullen oder leer).`);
    }
  }
  for (const schluessel of ACCESS_SCHLUESSEL) {
    if (istLeer(ebene.vars?.[schluessel])) probleme.push(`${umgebung}: vars.${schluessel} ist leer.`);
  }
  return probleme;
}

export function pruefeText(text, umgebung = "produktion") {
  return pruefe(parseJsonc(text), umgebung);
}

/** CLI-Kern: gibt den Exit-Code zurück, Meldungen über `ausgabe`. */
export function lauf(argv, ausgabe = { aus: console.log, fehler: console.error }) {
  const umgebung = argv[0] ?? "produktion";
  const pfad = argv[1] ?? fileURLToPath(new URL("../../../apps/api/wrangler.jsonc", import.meta.url));
  let probleme;
  try {
    probleme = pruefeText(readFileSync(pfad, "utf8"), umgebung);
  } catch (e) {
    ausgabe.fehler(`Platzhalter-Sperre: ${pfad} nicht lesbar: ${e.message}`);
    return 1;
  }
  if (probleme.length === 0) {
    ausgabe.aus(`Platzhalter-Sperre: ${umgebung} ok.`);
    return 0;
  }
  ausgabe.fehler(`Platzhalter-Sperre: Deploy für ${umgebung} abgebrochen.`);
  for (const p of probleme) ausgabe.fehler(`  - ${p}`);
  ausgabe.fehler("Erst die echten Werte eintragen (npm run einrichten -w @kfz/betrieb gibt die D1-ID aus).");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(lauf(process.argv.slice(2)));
}
