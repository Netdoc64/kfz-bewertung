import type { Fahrzeug } from "@kfz/shared";
import { describe, expect, it } from "vitest";
import { bewerte, ladeBewertungsEinstellungen, type BewertungsEinstellungen } from "../src/bewertung/bewerten.js";
import {
  alterInJahren,
  berechneKorrektur,
  filterInserate,
  iqrBereinigen,
  konfidenz,
  median,
  quantil,
  runde,
  streuungProzent,
} from "../src/bewertung/kern.js";
import * as D from "./golden/daten.js";
import { GOLDEN_EINSTELLUNGEN, REGEL_HOHE_KM, REGEL_OHNE_HEFT } from "./golden/einstellungen.js";

const lauf = (
  fahrzeug: Fahrzeug,
  stufen: Parameters<typeof D.festeSuche>[0],
  e: BewertungsEinstellungen = GOLDEN_EINSTELLUNGEN,
  extra: { klasse?: string; kiEinordnung?: string } = {},
) => bewerte({ fahrzeug, suche: D.festeSuche(stufen), einstellungen: e, heute: D.HEUTE, ...extra });

describe("Statistik", () => {
  it("Quantil und Median", () => {
    expect(quantil([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
  it("Streuung als Variationskoeffizient", () => {
    expect(streuungProzent([100, 100, 100])).toBe(0);
    expect(streuungProzent([90, 110])).toBeCloseTo(10, 10);
  });
  it("IQR entfernt Ausreißer, lässt unter vier Werten alles", () => {
    const r = iqrBereinigen([10, 11, 12, 13, 14, 100], (x) => x, 1.5);
    expect(r.verworfen).toEqual([100]);
    expect(iqrBereinigen([1, 1000, 5], (x) => x, 1.5).verworfen).toEqual([]);
  });
  it("Alter in Jahren", () => {
    expect(alterInJahren("2020-06", D.HEUTE)).toBeCloseTo(6, 10);
    expect(alterInJahren("2030-01", D.HEUTE)).toBe(0);
  });
  it("Rundung auf Schritt", () => {
    expect(runde(8248.4, 50)).toBe(8250);
    expect(runde(8224, 50)).toBe(8200);
  });
});

describe("Filter", () => {
  const i = (id: string, preis: number, titel = "x", beschreibung?: string) => ({
    id,
    titel,
    ...(beschreibung ? { beschreibung } : {}),
    preisBruttoEuro: preis,
    anbieter: "haendler" as const,
  });
  it("verwirft Platzhalterpreise, Ausschlussbegriffe (Titel und Beschreibung, ohne Groß/Klein) und Dubletten", () => {
    const r = filterInserate([i("a", 1), i("b", 9000, "EXPORT"), i("c", 9000, "ok", "Leasingübernahme"), i("d", 9000), i("d", 9000)], {
      mindestPreisEuro: 500,
      ausschlussBegriffe: ["export", "leasingübernahme"],
    });
    expect(r.zuGuenstig.map((x) => x.id)).toEqual(["a"]);
    expect(r.ausschlussBegriff.map((x) => x.id)).toEqual(["b", "c"]);
    expect(r.dubletten.map((x) => x.id)).toEqual(["d"]);
    expect(r.behalten.map((x) => x.id)).toEqual(["d"]);
  });
  it("leerer Ausschlussbegriff trifft nicht alles", () => {
    expect(filterInserate([i("a", 9000)], { mindestPreisEuro: 0, ausschlussBegriffe: [""] }).behalten).toHaveLength(1);
  });
});

describe("Korrektur und Konfidenz", () => {
  const basis = { kmKorrekturProzentJe10000: 2.5, alterKorrekturProzentJeJahr: 8 };
  it("mehr km und älter → Abschlag", () => {
    const k = berechneKorrektur({ ...basis, zielKilometer: 120000, zielAlterJahre: 7, vergleichKilometer: 100000, vergleichAlterJahre: 6 });
    expect(k).toMatchObject({ kmProzent: -5, alterProzent: -8, gesamtProzent: -13, fehlend: [] });
  });
  it("fehlende Angaben werden nicht geraten", () => {
    const k = berechneKorrektur({ ...basis, zielKilometer: undefined, zielAlterJahre: 7, vergleichKilometer: 100000, vergleichAlterJahre: 6 });
    expect(k.kmProzent).toBe(0);
    expect(k.fehlend).toEqual(["kilometer"]);
  });
  it("Konfidenz sinkt mit wenig Treffern und hoher Streuung", () => {
    const e = { anzahl: 10, zielVergleiche: 10, streuungProzent: 5, streuungGrenzeProzent: 15 };
    expect(konfidenz(e)).toBe(1);
    expect(konfidenz({ ...e, anzahl: 4, zielVergleiche: 16 })).toBe(0.5);
    expect(konfidenz({ ...e, streuungProzent: 30 })).toBe(0.5);
    expect(konfidenz({ ...e, anzahl: 0 })).toBe(0);
  });
});

describe("Goldene Fälle — exakte Preise", () => {
  it("Segment Kleinwagen (Polo): Filter, IQR, Korrektur, Regel, Rundung", async () => {
    const r = await lauf(D.POLO, [D.POLO_INSERATE]);
    expect(r.versuche).toEqual([{ stufe: 0, treffer: 14, zuGuenstig: 1, ausschlussBegriff: 1, dubletten: 1, ausreisser: 1, bereinigt: 10 }]);
    expect(r.preisStatistik).toMatchObject({ medianEuro: 11100, q1Euro: 10650, q3Euro: 11550, streuungProzent: 5.18 });
    expect(r.korrektur).toMatchObject({ kmProzent: 3.13, alterProzent: -4, gesamtProzent: -0.87 });
    expect(r.marktpreisEuro).toBe(11000);
    expect(r.verkaufspreisEuro).toBe(10450);
    expect(r.abzuege).toEqual({ margeEuro: 1254.33, aufbereitungEuro: 400, standkostenEuro: 450, regelnEuro: 100 });
    expect(r.regeln?.angewendet.map((a) => a.id)).toEqual(["ohne-heft"]);
    expect(r.ankaufspreisEuro).toBe(8250);
    expect(r.spanne).toEqual({ vonEuro: 7850, bisEuro: 8650 });
    expect(r.konfidenz).toBe(1);
    expect(r.anMensch).toBeNull();
  });

  it("Segment Kompakt-Diesel (Golf): Suche wird bis Stufe 2 erweitert, Regel hohe-km", async () => {
    const suche = D.festeSuche(D.GOLF_STUFEN);
    const r = await bewerte({ fahrzeug: D.GOLF, suche, einstellungen: GOLDEN_EINSTELLUNGEN, heute: D.HEUTE });
    expect(suche.aufrufe).toHaveLength(3);
    expect(r.versuche.map((v) => v.bereinigt)).toEqual([3, 6, 10]);
    expect(r.stufe).toBe(2);
    expect(r.versuche[2]).toMatchObject({ ausschlussBegriff: 2 });
    expect(r.preisStatistik?.medianEuro).toBe(14200);
    expect(r.korrektur).toMatchObject({ kmProzent: -3.12, alterProzent: 0 });
    expect(r.marktpreisEuro).toBe(13750);
    expect(r.verkaufspreisEuro).toBe(13050);
    expect(r.regeln?.angewendet.map((a) => a.id)).toEqual(["hohe-km"]);
    expect(r.regeln?.gesamtAbschlagEuro).toBe(522.74);
    expect(r.ankaufspreisEuro).toBe(10150);
    expect(r.spanne).toEqual({ vonEuro: 9650, bisEuro: 10650 });
    expect(r.anMensch).toBeNull();
  });

  it("Segment Premium-SUV (X5): Konfidenz aus Trefferzahl und Streuung", async () => {
    const suche = D.festeSuche([D.X5_INSERATE]);
    const r = await bewerte({ fahrzeug: D.X5, suche, einstellungen: GOLDEN_EINSTELLUNGEN, heute: D.HEUTE });
    expect(suche.aufrufe).toHaveLength(3); // 8 < Ziel 10 → Suche läuft durch alle Stufen
    expect(r.stufe).toBe(0); // gleiche Trefferzahl → früheste (engste) Stufe
    expect(r.marktpreisEuro).toBe(33100);
    expect(r.verkaufspreisEuro).toBe(31450);
    expect(r.ankaufspreisEuro).toBe(26850);
    expect(r.spanne).toEqual({ vonEuro: 25500, bisEuro: 28200 });
    expect(r.konfidenz).toBe(0.89);
    expect(r.anMensch).toBeNull();
  });

  it("zu wenige Vergleiche → an_mensch mit Grund", async () => {
    const r = await lauf(D.SELTEN, [D.SELTEN_INSERATE]);
    expect(r.anzahlVergleiche).toBe(3);
    expect(r.konfidenz).toBe(0.55);
    expect(r.ankaufspreisEuro).toBe(4400);
    expect(r.anMensch?.gruende[0]).toEqual({ code: "zu_wenige_vergleiche", werte: { anzahl: 3, mindestens: 5 } });
  });

  it("keine Vergleiche → keine Preise, an_mensch", async () => {
    const r = await lauf(D.SELTEN, [[]]);
    expect(r).toMatchObject({ stufe: null, marktpreisEuro: null, ankaufspreisEuro: null, spanne: null, konfidenz: 0 });
    expect(r.anMensch?.gruende.map((g) => g.code)).toEqual(["zu_wenige_vergleiche"]);
  });

  it("Deckel der Regelabschläge greift, Spanne verletzt → an_mensch", async () => {
    const mangel = { ...REGEL_HOHE_KM, id: "mangel", bedingungen: [], wirkung: { art: "prozent" as const, wert: 50 } };
    const e = { ...GOLDEN_EINSTELLUNGEN, "ankauf.regeln": [mangel] };
    const r = await lauf(D.POLO, [D.POLO_INSERATE], e);
    expect(r.regeln).toMatchObject({ gedeckelt: true, gesamtAbschlagEuro: 3135.82, abschlagVorDeckelEuro: 5226.37 });
    expect(r.verkaufspreisEuro).toBe(10450);
    expect(r.ankaufspreisEuro).toBe(5200);
    expect(r.anMensch?.gruende).toEqual([{ code: "spanne_zu_gross", werte: { spanneProzent: 50.24, hoechstensProzent: 25 } }]);
  });
});

describe("Eskalation (A6) und Plausibilität (A7)", () => {
  const mit = (teil: Partial<BewertungsEinstellungen>): BewertungsEinstellungen => ({ ...GOLDEN_EINSTELLUNGEN, ...teil });
  const codes = (r: Awaited<ReturnType<typeof lauf>>) => r.anMensch?.gruende.map((g) => g.code) ?? [];
  const esk = GOLDEN_EINSTELLUNGEN["ablauf.eskalation"];

  it("Ankauf über Höchstbetrag", async () => {
    const e = mit({ "ablauf.eskalation": { ...esk, maxAnkaufEuro: 20000 } });
    expect(codes(await lauf(D.X5, [D.X5_INSERATE], e))).toEqual(["ankauf_ueber_maximum"]);
  });
  it("Konfidenz unter Schwelle", async () => {
    const e = mit({ "ablauf.eskalation": { ...esk, konfidenzMin: 0.95 } });
    expect(codes(await lauf(D.X5, [D.X5_INSERATE], e))).toEqual(["konfidenz_zu_niedrig"]);
  });
  it("Ankauf unter Mindestpreis", async () => {
    const e = mit({ "ankauf.mindestPreisEuro": 9000 });
    expect(codes(await lauf(D.POLO, [D.POLO_INSERATE], e))).toEqual(["ankauf_unter_minimum"]);
  });
  it("Ankauf nie über Marktpreis", async () => {
    const ohneAbzug = mit({
      "ankauf.margeProzent": 0,
      "ankauf.aufbereitungPauschaleEuro": 0,
      "ankauf.standkostenEuroJeTag": 0,
      "bewertung.angebotsAbschlagProzent": 0,
      "ankauf.regeln": [],
    });
    const r = await lauf(D.POLO, [D.POLO_INSERATE], ohneAbzug);
    expect(r.ankaufspreisEuro).toBe(r.marktpreisEuro);
    expect(codes(r)).toEqual([]);
    const r2 = await lauf(D.POLO, [D.POLO_INSERATE], { ...ohneAbzug, "ankauf.aufbereitungPauschaleEuro": -500 });
    expect(codes(r2)).toEqual(["ankauf_ueber_marktpreis"]);
  });
  it("ausgeschlossene Fahrzeugklasse und KI-Einordnung sonstiges", async () => {
    expect(codes(await lauf(D.POLO, [D.POLO_INSERATE], GOLDEN_EINSTELLUNGEN, { klasse: "oldtimer" }))).toEqual(["fahrzeugklasse_ausgeschlossen"]);
    expect(codes(await lauf(D.POLO, [D.POLO_INSERATE], GOLDEN_EINSTELLUNGEN, { kiEinordnung: "sonstiges" }))).toEqual(["ki_sonstiges"]);
    const aus = mit({ "ablauf.eskalation": { ...esk, sonstigesAnMensch: false } });
    expect(codes(await lauf(D.POLO, [D.POLO_INSERATE], aus, { kiEinordnung: "sonstiges" }))).toEqual([]);
  });
  it("fehlende km/EZ am Zielfahrzeug: keine Korrektur, im Ergebnis vermerkt", async () => {
    const r = await lauf({ ...D.POLO, kilometer: undefined, erstzulassung: undefined }, [D.POLO_INSERATE]);
    expect(r.korrektur).toMatchObject({ gesamtProzent: 0, fehlend: ["kilometer", "erstzulassung"] });
  });
});

describe("Einstellungen laden", () => {
  it("liest jeden Schlüssel über lese()", async () => {
    const gelesen: string[] = [];
    const e = await ladeBewertungsEinstellungen({
      async lese(k) {
        gelesen.push(k);
        return (GOLDEN_EINSTELLUNGEN as Record<string, unknown>)[k] as never;
      },
    });
    expect(e).toEqual(GOLDEN_EINSTELLUNGEN);
    expect(gelesen).toHaveLength(Object.keys(GOLDEN_EINSTELLUNGEN).length);
  });
  it("REGEL_OHNE_HEFT bleibt in den goldenen Einstellungen", () => {
    expect(GOLDEN_EINSTELLUNGEN["ankauf.regeln"]).toContain(REGEL_OHNE_HEFT);
  });
});
