import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";
import { berechne, dauer, konfidenzKlassen } from "../src/kennzahlen/index.js";

const holen = (abfrage = "") => app.request(`http://lokal/api/admin/kennzahlen${abfrage}`, {}, env);
const VON = "2026-01-01T00:00:00.000Z";
const BIS = "2026-02-01T00:00:00.000Z";
const ZEIT = `?von=${VON}&bis=${BIS}`;

async function ereignis(anfrage: string, aktion: string, von: string | null, nach: string, am: string, notiz: string | null = null, durch = "system") {
  await env.DB.prepare("INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, notiz, korrelation, am) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'k', ?7)")
    .bind(anfrage, aktion, von, nach, durch, notiz, am)
    .run();
}
async function bericht(anfrage: string, konfidenz: number, erstellt: string) {
  await env.DB.prepare(
    "INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck, einstellungs_versionen, gueltig_bis, html_ablage, html, erstellt_am) VALUES (?1, ?2, 1, 'de', '{}', '[]', ?3, 'x', '{}', '2030-01-01T00:00:00.000Z', 'd1', '<p/>', ?4)",
  )
    .bind(`b-${anfrage}`, anfrage, JSON.stringify({ konfidenz }), erstellt)
    .run();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM berichte; DELETE FROM anfrage_ereignisse; DELETE FROM anfragen; DELETE FROM einstellungen;");
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) await env.DB.prepare("INSERT INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'admin', 'eingegangen', '{}')").bind(id).run();
  const T = "2026-01-10T";
  // a1: bis zur Freigabe, dann freigegeben (offen)
  await ereignis("a1", "angelegt", null, "eingegangen", `${T}10:00:00.000Z`);
  await ereignis("a1", "bewertung_starten", "eingegangen", "in_bewertung", `${T}10:00:10.000Z`);
  await ereignis("a1", "bewertung_fertig", "in_bewertung", "zur_freigabe", `${T}10:01:00.000Z`);
  await ereignis("a1", "freigeben", "zur_freigabe", "freigegeben", `${T}10:11:00.000Z`, null, "admin");
  // a2: an Mensch mit zwei Gründen
  await ereignis("a2", "angelegt", null, "eingegangen", `${T}11:00:00.000Z`);
  await ereignis("a2", "bewertung_starten", "eingegangen", "in_bewertung", `${T}11:00:30.000Z`);
  await ereignis("a2", "uebergeben", "in_bewertung", "an_mensch", `${T}11:01:30.000Z`, "konfidenz_zu_niedrig,ausgeschlossene_klasse");
  // a3: Fehlschlag
  await ereignis("a3", "angelegt", null, "eingegangen", `${T}12:00:00.000Z`);
  await ereignis("a3", "bewertung_starten", "eingegangen", "in_bewertung", `${T}12:00:20.000Z`);
  await ereignis("a3", "fehlschlag", "in_bewertung", "fehlgeschlagen", `${T}12:00:50.000Z`);
  // a4: abgelehnt
  await ereignis("a4", "angelegt", null, "eingegangen", `${T}13:00:00.000Z`);
  await ereignis("a4", "bewertung_starten", "eingegangen", "in_bewertung", `${T}13:00:40.000Z`);
  await ereignis("a4", "bewertung_fertig", "in_bewertung", "zur_freigabe", `${T}13:01:00.000Z`);
  await ereignis("a4", "ablehnen", "zur_freigabe", "abgelehnt", `${T}13:03:00.000Z`, null, "admin");
  // a5: vor dem Zeitraum
  await ereignis("a5", "angelegt", null, "eingegangen", "2025-12-31T10:00:00.000Z");
  await bericht("a1", 0.9, `${T}10:01:00.000Z`);
  await bericht("a2", 0.3, `${T}11:01:30.000Z`);
  await bericht("a4", 0.6, `${T}13:01:00.000Z`);
  await bericht("a3", 0.75, `${T}12:00:50.000Z`);
  await bericht("a5", 0.1, "2025-12-31T10:00:00.000Z");
});

describe("Kennzahlen (A12)", () => {
  it("liefert exakt erwartete Werte für feste Ereignisse", async () => {
    const r = await holen(ZEIT);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      zeitraum: { von: VON, bis: BIS },
      anfragen: 4,
      durchlaufzeit: {
        offen: 4,
        eingegangen: { anzahl: 4, mittel: 25, median: 25, max: 40 },
        in_bewertung: { anzahl: 4, mittel: 40, median: 40, max: 60 },
        zur_freigabe: { anzahl: 2, mittel: 360, median: 360, max: 600 },
      },
      anMensch: { anzahl: 1, anteil: 0.25, mitGrund: 1, anteilMitGrund: 1, gruende: { konfidenz_zu_niedrig: 1, ausgeschlossene_klasse: 1 } },
      konfidenz: {
        berichte: 4,
        mittel: 0.6375,
        klassen: [
          { von: null, bis: 0.5, anzahl: 1 },
          { von: 0.5, bis: 0.7, anzahl: 1 },
          { von: 0.7, bis: 0.85, anzahl: 1 },
          { von: 0.85, bis: null, anzahl: 1 },
        ],
      },
      fehlerrate: { bewertungen: 4, fehlgeschlagen: 1, rate: 0.25 },
      freigabedauer: { anzahl: 2, mittel: 360, median: 360, max: 600 },
    });
  });

  it("nimmt Klassengrenzen aus den Einstellungen", async () => {
    await env.DB.prepare("INSERT INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('ablauf.kennzahlenKonfidenzGrenzen', '[0.8]', 1, 'test')").run();
    const k = ((await (await holen(ZEIT)).json()) as { konfidenz: { klassen: unknown[] } }).konfidenz.klassen;
    expect(k).toEqual([
      { von: null, bis: 0.8, anzahl: 3 },
      { von: 0.8, bis: null, anzahl: 1 },
    ]);
  });

  it("enger Zeitraum zählt nur dort begonnene Ereignisse", async () => {
    const r = await holen("?von=2026-01-10T11:00:00.000Z&bis=2026-01-10T12:00:00.000Z");
    const k = (await r.json()) as { anfragen: number; fehlerrate: { rate: number | null }; freigabedauer: { anzahl: number; mittel: number | null } };
    expect(k.anfragen).toBe(1);
    expect(k.fehlerrate.rate).toBe(0);
    expect(k.freigabedauer).toEqual({ anzahl: 0, mittel: null, median: null, max: null });
  });

  it("ohne Zeitraum gilt der Standard aus der Registry", async () => {
    const k = (await (await holen()).json()) as { zeitraum: { von: string; bis: string } };
    expect(Date.parse(k.zeitraum.bis) - Date.parse(k.zeitraum.von)).toBe(30 * 86_400_000);
  });

  it("lehnt ungültigen Zeitraum ab", async () => {
    expect((await holen("?von=gestern")).status).toBe(400);
    expect((await holen(`?von=${BIS}&bis=${VON}`)).status).toBe(400);
  });

  it("leere Datenbasis ergibt null statt Division durch null", () => {
    const k = berechne({ von: VON, bis: BIS }, [], [], [0.5]);
    expect(k.anMensch).toEqual({ anzahl: 0, anteil: null, mitGrund: 0, anteilMitGrund: null, gruende: {} });
    expect(k.fehlerrate.rate).toBeNull();
    expect(k.konfidenz.mittel).toBeNull();
  });

  it("Hilfsfunktionen: Median gerade/ungerade, Klassenrand gehört nach oben", () => {
    expect(dauer([1, 2, 10])).toEqual({ anzahl: 3, mittel: 4.333333, median: 2, max: 10 });
    expect(dauer([1, 3])).toEqual({ anzahl: 2, mittel: 2, median: 2, max: 3 });
    expect(konfidenzKlassen([0.5], [0.5]).map((x) => x.anzahl)).toEqual([0, 1]);
  });
});
