import type { Vergleichsinserat } from "../quelle/port.js";

/** Reine Statistik und Filter des Bewertungskerns. Keine fachlichen Werte: alles kommt als Parameter. */

export function runde(wert: number, schritt: number): number {
  return Math.round(wert / schritt) * schritt;
}

export function rundeCent(wert: number): number {
  return Math.round(wert * 100) / 100 + 0; // + 0 macht aus -0 eine 0
}

/** Quantil mit linearer Interpolation (Typ 7). `sortiert` aufsteigend, nicht leer. */
export function quantil(sortiert: readonly number[], p: number): number {
  const pos = (sortiert.length - 1) * p;
  const unten = Math.floor(pos);
  const oben = Math.ceil(pos);
  const a = sortiert[unten] as number;
  const b = sortiert[oben] as number;
  return a + (b - a) * (pos - unten);
}

export function sortiert(werte: readonly number[]): number[] {
  return [...werte].sort((a, b) => a - b);
}

/** Median; undefined bei leerer Liste. */
export function median(werte: readonly number[]): number | undefined {
  if (werte.length === 0) return undefined;
  return quantil(sortiert(werte), 0.5);
}

/** Variationskoeffizient in Prozent (Standardabweichung der Grundgesamtheit / Mittelwert). */
export function streuungProzent(werte: readonly number[]): number {
  if (werte.length === 0) return 0;
  const mittel = werte.reduce((s, w) => s + w, 0) / werte.length;
  if (mittel === 0) return 0;
  const varianz = werte.reduce((s, w) => s + (w - mittel) ** 2, 0) / werte.length;
  return (Math.sqrt(varianz) / mittel) * 100;
}

export interface IqrErgebnis<T> {
  behalten: T[];
  verworfen: T[];
  untereGrenze: number;
  obereGrenze: number;
}

/** Entfernt Werte außerhalb [Q1 − f·IQR, Q3 + f·IQR]. Unter vier Werten wird nichts entfernt. */
export function iqrBereinigen<T>(eintraege: readonly T[], wert: (e: T) => number, faktor: number): IqrErgebnis<T> {
  const preise = sortiert(eintraege.map(wert));
  if (preise.length < 4) {
    return { behalten: [...eintraege], verworfen: [], untereGrenze: preise[0] ?? 0, obereGrenze: preise[preise.length - 1] ?? 0 };
  }
  const q1 = quantil(preise, 0.25);
  const q3 = quantil(preise, 0.75);
  const iqr = q3 - q1;
  const untereGrenze = q1 - faktor * iqr;
  const obereGrenze = q3 + faktor * iqr;
  const behalten: T[] = [];
  const verworfen: T[] = [];
  for (const e of eintraege) (wert(e) >= untereGrenze && wert(e) <= obereGrenze ? behalten : verworfen).push(e);
  return { behalten, verworfen, untereGrenze, obereGrenze };
}

export interface FilterEinstellung {
  mindestPreisEuro: number;
  ausschlussBegriffe: readonly string[];
}

export interface FilterErgebnis {
  behalten: Vergleichsinserat[];
  zuGuenstig: Vergleichsinserat[];
  ausschlussBegriff: Vergleichsinserat[];
  dubletten: Vergleichsinserat[];
}

/** Vergleichspreis, vereinheitlicht auf Brutto (Netto-Angaben werden nicht gemischt). */
export function vergleichsPreis(i: Vergleichsinserat): number {
  return i.preisBruttoEuro;
}

export function filterInserate(inserate: readonly Vergleichsinserat[], f: FilterEinstellung): FilterErgebnis {
  const begriffe = f.ausschlussBegriffe.map((b) => b.toLowerCase()).filter((b) => b !== "");
  const gesehen = new Set<string>();
  const r: FilterErgebnis = { behalten: [], zuGuenstig: [], ausschlussBegriff: [], dubletten: [] };
  for (const i of inserate) {
    if (gesehen.has(i.id)) {
      r.dubletten.push(i);
      continue;
    }
    gesehen.add(i.id);
    const text = `${i.titel} ${i.beschreibung ?? ""}`.toLowerCase();
    if (vergleichsPreis(i) < f.mindestPreisEuro) r.zuGuenstig.push(i);
    else if (begriffe.some((b) => text.includes(b))) r.ausschlussBegriff.push(i);
    else r.behalten.push(i);
  }
  return r;
}

/** Alter in Jahren (mit Bruchteil) seit Erstzulassung JJJJ-MM. */
export function alterInJahren(erstzulassung: string, heute: Date): number {
  const [j = 0, m = 1] = erstzulassung.split("-").map(Number);
  const monate = (heute.getUTCFullYear() - j) * 12 + (heute.getUTCMonth() + 1 - m);
  return Math.max(0, monate) / 12;
}

export interface KorrekturEingabe {
  zielKilometer: number | undefined;
  zielAlterJahre: number | undefined;
  /** Median-Kilometer / Median-Alter der Vergleiche; undefined, wenn keiner eine Angabe hat. */
  vergleichKilometer: number | undefined;
  vergleichAlterJahre: number | undefined;
  kmKorrekturProzentJe10000: number;
  alterKorrekturProzentJeJahr: number;
}

export interface Korrektur {
  kmProzent: number;
  alterProzent: number;
  gesamtProzent: number;
  /** Angaben, die für die Korrektur fehlten. */
  fehlend: ("kilometer" | "erstzulassung")[];
}

/** Mehr km / älter als der Median der Vergleiche → Abschlag; weniger/jünger → Zuschlag. */
export function berechneKorrektur(e: KorrekturEingabe): Korrektur {
  const fehlend: Korrektur["fehlend"] = [];
  let kmProzent = 0;
  let alterProzent = 0;
  if (e.zielKilometer === undefined || e.vergleichKilometer === undefined) fehlend.push("kilometer");
  else kmProzent = -((e.zielKilometer - e.vergleichKilometer) / 10000) * e.kmKorrekturProzentJe10000;
  if (e.zielAlterJahre === undefined || e.vergleichAlterJahre === undefined) fehlend.push("erstzulassung");
  else alterProzent = -(e.zielAlterJahre - e.vergleichAlterJahre) * e.alterKorrekturProzentJeJahr;
  return { kmProzent, alterProzent, gesamtProzent: kmProzent + alterProzent, fehlend };
}

export interface KonfidenzEingabe {
  anzahl: number;
  zielVergleiche: number;
  streuungProzent: number;
  streuungGrenzeProzent: number;
}

/**
 * Konfidenz 0–1: Wurzel des Trefferanteils am Ziel, mal Streuungsfaktor
 * (1 bis zur Grenze, darüber Grenze/Streuung). Keine Gewichte, nur Verhältnisse.
 */
export function konfidenz(e: KonfidenzEingabe): number {
  if (e.anzahl <= 0) return 0;
  const menge = Math.sqrt(Math.min(1, e.anzahl / e.zielVergleiche));
  const streuung = e.streuungProzent <= e.streuungGrenzeProzent ? 1 : e.streuungGrenzeProzent / e.streuungProzent;
  return Math.round(menge * streuung * 100) / 100;
}
