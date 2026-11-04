import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lauf, pruefe, pruefeText } from "../src/platzhalter.mjs";

const fixtureUrl = (name: string) => new URL(`./fixtures/platzhalter/${name}`, import.meta.url);
const fixture = (name: string) => readFileSync(fixtureUrl(name), "utf8");
const echteUrl = new URL("../../../apps/api/wrangler.jsonc", import.meta.url);

function mitSammler() {
  const aus: string[] = [];
  const fehler: string[] = [];
  return { aus, fehler, ausgabe: { aus: (z: string) => aus.push(z), fehler: (z: string) => fehler.push(z) } };
}

describe("pruefe", () => {
  it("bricht bei Null-ID ab", () => {
    const p = pruefeText(fixture("null-id.jsonc"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("database_id");
  });

  it("bricht bei leeren ACCESS_* ab", () => {
    const p = pruefeText(fixture("access-leer.jsonc"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("ACCESS_TEAM_DOMAIN");
  });

  it("lässt eine vollständig gesetzte Produktion durch", () => {
    expect(pruefeText(fixture("alles-gesetzt.jsonc"))).toEqual([]);
  });

  it("nimmt entwicklung aus", () => {
    expect(pruefeText(fixture("null-id.jsonc"), "entwicklung")).toEqual([]);
  });

  it("sperrt vorschau getrennt von Produktion", () => {
    const p = pruefeText(fixture("alles-gesetzt.jsonc"), "vorschau");
    expect(p.some((z) => z.includes("database_id"))).toBe(true);
    expect(p.some((z) => z.includes("ACCESS_AUD"))).toBe(true);
    expect(p.some((z) => z.includes("ACCESS_TEAM_DOMAIN"))).toBe(false);
  });

  it("meldet eine unbekannte Umgebung", () => {
    expect(pruefeText(fixture("alles-gesetzt.jsonc"), "gibtsnicht")[0]).toContain("gibtsnicht");
  });

  it("meldet fehlende oder nicht-textuelle Werte", () => {
    expect(pruefe({ vars: { ACCESS_TEAM_DOMAIN: 5 } })).toHaveLength(3);
    const ohneId = { d1_databases: [{ binding: "DB" }], vars: { ACCESS_TEAM_DOMAIN: "a", ACCESS_AUD: "b" } };
    expect(pruefe(ohneId)).toHaveLength(1);
  });
});

describe("lauf", () => {
  it("Exit 0 bei freier Konfiguration", () => {
    const s = mitSammler();
    expect(lauf(["produktion", fileURLToPath(fixtureUrl("alles-gesetzt.jsonc"))], s.ausgabe)).toBe(0);
    expect(s.aus[0]).toContain("ok");
  });

  it("Exit 1 mit klarer Meldung bei Platzhalter", () => {
    const s = mitSammler();
    expect(lauf(["produktion", fileURLToPath(fixtureUrl("null-id.jsonc"))], s.ausgabe)).toBe(1);
    expect(s.fehler.join("\n")).toContain("abgebrochen");
  });

  it("Exit 1, wenn die Datei fehlt", () => {
    const s = mitSammler();
    expect(lauf(["produktion", "/gibt/es/nicht.jsonc"], s.ausgabe)).toBe(1);
    expect(s.fehler[0]).toContain("nicht lesbar");
  });
});

describe("echtes wrangler.jsonc", () => {
  const text = readFileSync(echteUrl, "utf8");

  it("ist für Produktion gesperrt, solange Platzhalter drinstehen", () => {
    expect(pruefeText(text, "produktion").length).toBeGreaterThan(0);
    expect(lauf(["produktion", fileURLToPath(echteUrl)], mitSammler().ausgabe)).toBe(1);
  });

  it("lässt entwicklung durch", () => {
    expect(pruefeText(text, "entwicklung")).toEqual([]);
  });
});
