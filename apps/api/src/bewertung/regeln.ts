import type { AnkaufRegel, Fahrzeug, RegelFeld } from "@kfz/shared";

type Bedingung = AnkaufRegel["bedingungen"][number];
type Wert = string | number | boolean | string[] | undefined | null;

export interface RegelEingabe {
  fahrzeug: Fahrzeug;
  regeln: AnkaufRegel[];
  /** Erwarteter Verkaufspreis in Euro; Basis für Prozent-Wirkungen. */
  verkaufspreisEuro: number;
  /** Aus `ankauf.maxGesamtAbschlagProzent`. */
  maxGesamtAbschlagProzent: number;
  /** Stichtag für das abgeleitete Feld alterJahre. */
  heute: Date;
}

export interface AngewendeteRegel {
  id: string;
  bezeichnung: string;
  begruendung: string;
  /** Wirkung in Euro: positiv = Abschlag, negativ = Zuschlag (vor dem Deckel). */
  betragEuro: number;
}

export interface RegelErgebnis {
  angewendet: AngewendeteRegel[];
  /** Summe der Abschläge nach Deckel und Verrechnung mit Zuschlägen, in Euro (>= 0). */
  gesamtAbschlagEuro: number;
  /** Ungedeckelte Summe der Abschläge in Euro. */
  abschlagVorDeckelEuro: number;
  gedeckelt: boolean;
}

/** Alter in Jahren (mit Bruchteil) seit Erstzulassung JJJJ-MM; undefined ohne Angabe. */
function alterJahre(fahrzeug: Fahrzeug, heute: Date): number | undefined {
  if (!fahrzeug.erstzulassung) return undefined;
  const [j = 0, m = 1] = fahrzeug.erstzulassung.split("-").map(Number);
  const monate = (heute.getUTCFullYear() - j) * 12 + (heute.getUTCMonth() + 1 - m);
  return Math.max(0, monate) / 12;
}

function feldWert(fahrzeug: Fahrzeug, feld: RegelFeld, heute: Date): Wert {
  if (feld === "alterJahre") return alterJahre(fahrzeug, heute);
  return fahrzeug[feld] as Wert;
}

function fehlt(w: Wert): boolean {
  return w === undefined || w === null || w === "" || (Array.isArray(w) && w.length === 0);
}

function gleich(w: Wert, soll: string | number | boolean): boolean {
  if (fehlt(w) || Array.isArray(w)) return false;
  if (typeof w === "string" && typeof soll === "string") return w.toLowerCase() === soll.toLowerCase();
  return w === soll;
}

/** Eine Bedingung. Fehlende Werte erfüllen jede Bedingung außer `fehlt`. */
export function bedingungErfuellt(b: Bedingung, fahrzeug: Fahrzeug, heute: Date): boolean {
  const w = feldWert(fahrzeug, b.feld, heute);
  if (b.op === "fehlt") return fehlt(w);
  if (fehlt(w)) return false;
  switch (b.op) {
    case "gleich":
      return gleich(w, b.wert);
    case "ungleich":
      return !gleich(w, b.wert);
    case "kleiner":
      return typeof w === "number" && w < b.wert;
    case "groesser":
      return typeof w === "number" && w > b.wert;
    case "zwischen":
      return typeof w === "number" && w >= b.von && w <= b.bis;
    case "enthaelt": {
      const n = b.wert.toLowerCase();
      if (Array.isArray(w)) return w.some((e) => e.toLowerCase() === n);
      return typeof w === "string" && w.toLowerCase().includes(n);
    }
  }
}

export function bewerteRegeln(eingabe: RegelEingabe): RegelErgebnis {
  const { fahrzeug, regeln, verkaufspreisEuro, maxGesamtAbschlagProzent, heute } = eingabe;
  const angewendet: AngewendeteRegel[] = [];
  for (const r of regeln) {
    if (!r.aktiv) continue;
    if (!r.bedingungen.every((b) => bedingungErfuellt(b, fahrzeug, heute))) continue;
    const betragEuro = r.wirkung.art === "prozent" ? (verkaufspreisEuro * r.wirkung.wert) / 100 : r.wirkung.wert;
    angewendet.push({ id: r.id, bezeichnung: r.bezeichnung, begruendung: r.begruendung, betragEuro });
  }
  const abschlag = angewendet.reduce((s, a) => s + Math.max(0, a.betragEuro), 0);
  const zuschlag = angewendet.reduce((s, a) => s + Math.max(0, -a.betragEuro), 0);
  const deckelEuro = (verkaufspreisEuro * maxGesamtAbschlagProzent) / 100;
  const gesamt = Math.max(0, Math.min(abschlag, deckelEuro) - zuschlag);
  return {
    angewendet,
    gesamtAbschlagEuro: Math.round(gesamt * 100) / 100,
    abschlagVorDeckelEuro: Math.round(abschlag * 100) / 100,
    gedeckelt: abschlag > deckelEuro,
  };
}
