import { env } from "cloudflare:test";
import type { Fahrzeug } from "@kfz/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { bewerte, ladeBewertungsEinstellungen } from "../src/bewertung/bewerten.js";
import { berichtSpeichern } from "../src/bericht/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import type { Vergleichsinserat } from "../src/quelle/port.js";
import { app } from "../src/index.js";

const jetzt = new Date();
const auto: Fahrzeug = { marke: "VW", modell: "Golf", kilometer: 120000, erstzulassung: "2018-06", ausstattung: [] };
const inserate: Vergleichsinserat[] = Array.from({ length: 12 }, (_, i) => ({
  id: `i${i}`,
  titel: `Golf ${i}`,
  preisBruttoEuro: 14000 + i * 100,
  kilometer: 100000 + i * 3000,
  erstzulassung: "2018-05",
  anbieter: "haendler" as const,
}));

const vorschau = (schluessel: string, body: unknown) =>
  app.request(
    `http://lokal/api/admin/einstellungen/${schluessel}/vorschau`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );

async function legeBerichtAn(anfrageId: string) {
  await env.DB.prepare("INSERT INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'admin', 'in_bewertung', '{}')").bind(anfrageId).run();
  const e = new Einstellungen(env.DB, async () => {});
  const bewertung = await bewerte({
    fahrzeug: auto,
    suche: { suche: async () => inserate },
    einstellungen: await ladeBewertungsEinstellungen(e),
    heute: jetzt,
  });
  await berichtSpeichern(env.DB, e, { anfrageId, generation: 1, fahrzeug: auto, bewertung, sprache: "de", jetzt });
}

const zaehleEinstellungen = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM einstellungen").first<{ n: number }>())!.n;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM berichte; DELETE FROM anfrage_ereignisse; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM einstellungen_verlauf;");
});

describe("POST /api/admin/einstellungen/:schluessel/vorschau", () => {
  it("zeigt den Unterschied und speichert nichts", async () => {
    await legeBerichtAn("a1");
    await legeBerichtAn("a2");
    const r = await vorschau("ankauf.margeProzent", { wert: 30 });
    expect(r.status).toBe(200);
    const k = (await r.json()) as { anzahl: number; geaendert: number; zeilen: { anfrageId: string; ankaufDifferenzEuro: number; vorher: { ankaufspreisEuro: number }; nachher: { ankaufspreisEuro: number } }[] };
    expect(k.anzahl).toBe(2);
    expect(k.geaendert).toBe(2);
    for (const z of k.zeilen) {
      expect(z.nachher.ankaufspreisEuro).toBeLessThan(z.vorher.ankaufspreisEuro);
      expect(z.ankaufDifferenzEuro).toBe(z.nachher.ankaufspreisEuro - z.vorher.ankaufspreisEuro);
    }
    expect(await zaehleEinstellungen()).toBe(0);
  });

  it("meldet keinen Unterschied für den unveränderten Wert", async () => {
    await legeBerichtAn("a1");
    const r = await vorschau("ankauf.margeProzent", { wert: null });
    expect(await r.json()).toMatchObject({ anzahl: 1, geaendert: 0 });
  });

  it("rechnet höchstens einstellungen.vorschauAnzahl Berichte", async () => {
    await legeBerichtAn("a1");
    await legeBerichtAn("a2");
    await legeBerichtAn("a3");
    await env.DB.prepare("INSERT INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('einstellungen.vorschauAnzahl', '2', 1, 'test')").run();
    const r = await vorschau("ankauf.margeProzent", { wert: 30 });
    expect(await r.json()).toMatchObject({ anzahl: 2 });
  });

  it("liefert nichts, wenn die Vorschau aus ist (0)", async () => {
    await legeBerichtAn("a1");
    await env.DB.prepare("INSERT INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('einstellungen.vorschauAnzahl', '0', 1, 'test')").run();
    const r = await vorschau("ankauf.margeProzent", { wert: 30 });
    expect(await r.json()).toMatchObject({ anzahl: 0, zeilen: [] });
  });

  it("weist ungültige Werte, fehlenden Wert und unbekannte Schlüssel ab", async () => {
    const schlecht = await vorschau("ankauf.margeProzent", { wert: "viel" });
    expect(schlecht.status).toBe(400);
    const leer = await vorschau("ankauf.margeProzent", {});
    expect(leer.status).toBe(400);
    const unbekannt = await vorschau("gibt.es.nicht", { wert: 1 });
    expect(unbekannt.status).toBe(404);
  });
});
