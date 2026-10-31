import type { Fahrzeug, SuchStufe } from "@kfz/shared";
import type { Suche, Vergleichsinserat } from "../../src/quelle/port.js";

/** Stichtag aller goldenen Fälle. */
export const HEUTE = new Date(Date.UTC(2026, 5, 15));

function ins(id: string, preis: number, kilometer: number, erstzulassung: string, titel = "Gebrauchtwagen", beschreibung?: string): Vergleichsinserat {
  return { id, titel, ...(beschreibung ? { beschreibung } : {}), preisBruttoEuro: preis, kilometer, erstzulassung, anbieter: "haendler" };
}

/** Feste Datenquelle: liefert je Suchstufe (Index über ezToleranzJahre) eine feste Liste. */
export function festeSuche(stufen: Vergleichsinserat[][]): Suche & { aufrufe: SuchStufe[] } {
  const aufrufe: SuchStufe[] = [];
  return {
    aufrufe,
    async suche(_fahrzeug: Fahrzeug, stufe: SuchStufe) {
      aufrufe.push(stufe);
      return stufen[Math.min(stufe.ezToleranzJahre, stufen.length - 1)] ?? [];
    },
  };
}

// --- Segment 1: Kleinwagen (VW Polo) ---------------------------------------
export const POLO: Fahrzeug = { marke: "VW", modell: "Polo", kilometer: 60000, erstzulassung: "2020-06", kraftstoff: "benzin", ausstattung: [] };
export const POLO_INSERATE: Vergleichsinserat[] = [
  ins("p1", 10200, 50000, "2021-06"),
  ins("p2", 10400, 55000, "2021-06"),
  ins("p3", 10600, 60000, "2021-06"),
  ins("p4", 10800, 65000, "2021-06"),
  ins("p5", 11000, 70000, "2021-06"),
  ins("p6", 11200, 75000, "2020-06"),
  ins("p7", 11400, 80000, "2020-06"),
  ins("p8", 11600, 85000, "2020-06"),
  ins("p9", 11800, 90000, "2020-06"),
  ins("p10", 12000, 95000, "2020-06"),
  ins("p-platzhalter", 1, 10, "2020-06"),
  ins("p-export", 8000, 70000, "2020-06", "Polo Export", undefined),
  ins("p-ausreisser", 25000, 70000, "2020-06"),
  ins("p1", 10200, 50000, "2021-06"), // Dublette
];

// --- Segment 2: Kompaktklasse Diesel (VW Golf), Suche muss erweitert werden ---
export const GOLF: Fahrzeug = { marke: "VW", modell: "Golf", kilometer: 180000, erstzulassung: "2016-06", kraftstoff: "diesel", scheckheft: true, ausstattung: [] };
const GOLF_NAH = [
  ins("g1", 14000, 150000, "2016-06"),
  ins("g2", 14400, 160000, "2016-06"),
  ins("g3", 14800, 170000, "2016-06"),
];
const GOLF_MITTEL = [
  ...GOLF_NAH,
  ins("g4", 13600, 190000, "2015-06"),
  ins("g5", 13200, 200000, "2015-06"),
  ins("g6", 15200, 140000, "2017-06"),
];
export const GOLF_STUFEN: Vergleichsinserat[][] = [
  GOLF_NAH,
  GOLF_MITTEL,
  [
    ...GOLF_MITTEL,
    ins("g7", 12800, 210000, "2014-06"),
    ins("g8", 15600, 130000, "2017-06"),
    ins("g9", 12400, 220000, "2014-06"),
    ins("g10", 16000, 120000, "2018-06", "Golf Unfallwagen", undefined),
    ins("g11", 14200, 175000, "2016-06", "Golf", "Leasingübernahme, Export möglich"),
    ins("g12", 14600, 165000, "2016-06"),
  ],
];

// --- Segment 3: Premium-SUV (BMW X5) -----------------------------------------
export const X5: Fahrzeug = { marke: "BMW", modell: "X5", kilometer: 100000, erstzulassung: "2019-06", kraftstoff: "diesel", scheckheft: true, ausstattung: [] };
export const X5_INSERATE: Vergleichsinserat[] = [
  ins("x1", 29000, 90000, "2019-06"),
  ins("x2", 30000, 95000, "2019-06"),
  ins("x3", 31000, 100000, "2019-06"),
  ins("x4", 32000, 105000, "2019-06"),
  ins("x5", 33000, 110000, "2019-06"),
  ins("x6", 34000, 115000, "2019-06"),
  ins("x7", 35000, 120000, "2019-06"),
  ins("x8", 36000, 125000, "2019-06"),
];

// --- Zu wenige Vergleiche -----------------------------------------------------
export const SELTEN: Fahrzeug = { marke: "Lancia", modell: "Delta", kilometer: 90000, erstzulassung: "2015-06", ausstattung: [] };
export const SELTEN_INSERATE: Vergleichsinserat[] = [ins("s1", 6000, 80000, "2015-06"), ins("s2", 6400, 95000, "2015-06"), ins("s3", 6800, 90000, "2015-06")];
