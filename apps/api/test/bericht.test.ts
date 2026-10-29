import { env } from "cloudflare:test";
import type { Fahrzeug } from "@kfz/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { bewerte, ladeBewertungsEinstellungen, type Bewertung } from "../src/bewertung/bewerten.js";
import { berichtIstGueltig, berichtLaden, berichtSpeichern, htmlEscape, rendereBericht } from "../src/bericht/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import type { Vergleichsinserat } from "../src/quelle/port.js";

const jetzt = new Date(Date.UTC(2026, 5, 15, 10, 0, 0));
const auto: Fahrzeug = { marke: "VW", modell: "Golf", kilometer: 120000, erstzulassung: "2018-06", ausstattung: [] };

const inserate: Vergleichsinserat[] = Array.from({ length: 12 }, (_, i) => ({
  id: `i${i}`,
  titel: `Golf ${i}`,
  preisBruttoEuro: 14000 + i * 100,
  kilometer: 100000 + i * 3000,
  erstzulassung: "2018-05",
  anbieter: "haendler" as const,
}));

function einst() {
  return new Einstellungen(env.DB, async () => {});
}

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')")
    .bind(schluessel, JSON.stringify(wert))
    .run();
}

async function bewertung(regelnAn = false): Promise<Bewertung> {
  const e = einst();
  const s = await ladeBewertungsEinstellungen(e);
  if (regelnAn) {
    s["ankauf.regeln"] = [
      { id: "r1", bezeichnung: "Hoher <b>Km</b>-Stand", aktiv: true, bedingungen: [], wirkung: { art: "betrag", wert: 300 }, begruendung: "Abnutzung & Risiko" },
    ];
  }
  return bewerte({ fahrzeug: auto, suche: { suche: async () => inserate }, einstellungen: s, heute: jetzt });
}

async function anfrage(id: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'admin', 'in_bewertung', '{}')").bind(id).run();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM berichte; DELETE FROM anfrage_ereignisse; DELETE FROM anfragen; DELETE FROM einstellungen;");
});

describe("Rendern", () => {
  it("enthält Hinweis, Vergleichsliste, Regeln und Suchstufe", async () => {
    const b = await bewertung(true);
    const vorlagen = await einst().lese("bericht.vorlagen");
    const r = rendereBericht({ fahrzeug: auto, bewertung: b, vorlagen, sprache: "de", gueltigBis: new Date(Date.UTC(2026, 5, 22)) });
    expect(r.html).toContain("kein Gutachten");
    expect(r.html.match(/<tr><td>/g)).toHaveLength(b.anzahlVergleiche);
    expect(r.html).toContain("Suchstufe 1 von");
    expect(r.html).toContain("Abnutzung &amp; Risiko");
    expect(r.html).toContain("22.06.2026");
    expect(r.html).toContain("VW Golf");
    expect(r.betreff).toBe("Ihre Fahrzeugbewertung: VW Golf 2018-06 120.000 km");
  });

  it("escaped Fahrzeug- und Regeltexte", async () => {
    const b = await bewertung(true);
    const vorlagen = await einst().lese("bericht.vorlagen");
    const r = rendereBericht({
      fahrzeug: { ...auto, modell: "<script>alert(1)</script>" },
      bewertung: b,
      vorlagen,
      sprache: "de",
      gueltigBis: jetzt,
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b>Km</b>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(htmlEscape(`a&"'<>`)).toBe("a&amp;&quot;&#39;&lt;&gt;");
  });

  it("wählt die Sprache, fällt auf de zurück und hängt fehlenden Hinweis an", async () => {
    const b = await bewertung();
    const vorlagen = {
      de: { betreff: "B de", html: "<p>{{fahrzeug}}</p>", hinweis: "Kein Gutachten (de)" },
      en: { betreff: "B en", html: "<p>{{fahrzeug}} {{ankaufVon}}</p>", hinweis: "No appraisal (en)" },
    };
    const en = rendereBericht({ fahrzeug: auto, bewertung: b, vorlagen, sprache: "en-GB", gueltigBis: jetzt });
    expect(en.sprache).toBe("en");
    expect(en.html).toContain("No appraisal (en)");
    expect(en.html).toMatch(/€|EUR/);
    const fr = rendereBericht({ fahrzeug: auto, bewertung: b, vorlagen, sprache: "fr", gueltigBis: jetzt });
    expect(fr.sprache).toBe("de");
    expect(fr.html).toContain("Kein Gutachten (de)");
  });

  it("setzt Werte nicht erneut als Platzhalter ein", async () => {
    const b = await bewertung();
    const vorlagen = { de: { betreff: "x", html: "{{fahrzeug}} {{hinweis}}", hinweis: "kein Gutachten" } };
    const r = rendereBericht({ fahrzeug: { ...auto, modell: "{{hinweis}}" }, bewertung: b, vorlagen, sprache: "de", gueltigBis: jetzt });
    expect(r.html).toContain("{{hinweis}}");
  });

  it("ohne Vorlage: BERICHT_VORLAGE_FEHLT", async () => {
    const b = await bewertung();
    expect(() => rendereBericht({ fahrzeug: auto, bewertung: b, vorlagen: {}, sprache: "de", gueltigBis: jetzt })).toThrow(
      expect.objectContaining({ code: "BERICHT_VORLAGE_FEHLT" }),
    );
  });
});

describe("Speichern", () => {
  const daten = async (generation = 1) => ({ anfrageId: "a1", generation, fahrzeug: auto, bewertung: await bewertung(), sprache: "de", jetzt });

  it("speichert Eingabe, Vergleiche, Zahlen, Abdruck und Gültigkeit", async () => {
    await anfrage("a1");
    await setze("ablauf.berichtGueltigTage", 3);
    const b = await berichtSpeichern(env.DB, einst(), await daten());
    const soll = await einst().abdruck();
    expect(b.neu).toBe(true);
    expect(b.einstellungsAbdruck).toBe(soll.abdruck);
    expect(b.einstellungsVersionen).toEqual(soll.versionen);
    expect(b.gueltigBis).toBe(new Date(jetzt.getTime() + 3 * 86_400_000).toISOString());
    expect(b.eingabe.fahrzeug).toEqual(auto);
    expect(b.vergleiche).toHaveLength(12);
    expect(b.zahlen.ankaufspreisEuro).toBeGreaterThan(0);
    expect(b.zahlen.suchStufe).not.toBeNull();
    expect(b.html).toContain("kein Gutachten");
    const geladen = await berichtLaden(env.DB, "a1");
    expect(geladen.html).toBe(b.html);
    expect(geladen.neu).toBe(false);
    expect(berichtIstGueltig(b, new Date(jetzt.getTime() + 2 * 86_400_000))).toBe(true);
    expect(berichtIstGueltig(b, new Date(jetzt.getTime() + 4 * 86_400_000))).toBe(false);
  });

  it("dieselbe Generation ist idempotent, auch bei geänderten Einstellungen", async () => {
    await anfrage("a1");
    const a = await berichtSpeichern(env.DB, einst(), await daten());
    await setze("ablauf.berichtGueltigTage", 30);
    const b = await berichtSpeichern(env.DB, einst(), await daten());
    expect(b.neu).toBe(false);
    expect(b.id).toBe(a.id);
    expect(b.gueltigBis).toBe(a.gueltigBis);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM berichte").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("parallel gespeichert entsteht ein Bericht", async () => {
    await anfrage("a1");
    const d = await daten();
    const [x, y] = await Promise.all([berichtSpeichern(env.DB, einst(), d), berichtSpeichern(env.DB, einst(), d)]);
    expect(x.id).toBe(y.id);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM berichte").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("neue Generation ergibt neuen Bericht; laden liefert den neuesten", async () => {
    await anfrage("a1");
    await berichtSpeichern(env.DB, einst(), await daten(1));
    await berichtSpeichern(env.DB, einst(), await daten(2));
    expect((await berichtLaden(env.DB, "a1")).generation).toBe(2);
    expect((await berichtLaden(env.DB, "a1", undefined, 1)).generation).toBe(1);
  });

  it("legt das HTML wahlweise in R2 ab", async () => {
    await anfrage("a1");
    const b = await berichtSpeichern(env.DB, einst(), await daten(), env.BERICHTE);
    const z = await env.DB.prepare("SELECT html_ablage, html, r2_schluessel FROM berichte").first<{ html_ablage: string; html: string | null; r2_schluessel: string }>();
    expect(z).toMatchObject({ html_ablage: "r2", html: null, r2_schluessel: "berichte/a1/1.html" });
    expect((await env.BERICHTE.get("berichte/a1/1.html"))?.text()).resolves.toBe(b.html);
    expect((await berichtLaden(env.DB, "a1", env.BERICHTE)).html).toBe(b.html);
    const wieder = await berichtSpeichern(env.DB, einst(), await daten(), env.BERICHTE);
    expect(wieder.neu).toBe(false);
  });

  it("unbekannte Anfrage: BERICHT_FEHLT", async () => {
    await expect(berichtLaden(env.DB, "gibt-es-nicht")).rejects.toMatchObject({ code: "BERICHT_FEHLT" });
  });
});
