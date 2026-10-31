import type { AnkaufRegel, Fahrzeug } from "@kfz/shared";
import { describe, expect, it } from "vitest";
import { bewerteRegeln } from "../src/bewertung/regeln.js";

type Bed = AnkaufRegel["bedingungen"][number];
const heute = new Date(Date.UTC(2026, 5, 15));
const auto: Fahrzeug = {
  marke: "VW",
  modell: "Golf",
  kilometer: 150000,
  kraftstoff: "diesel",
  erstzulassung: "2016-06",
  ausstattung: ["Navi", "Anhängerkupplung"],
};

function regel(bedingungen: Bed[], wert = 10, art: "prozent" | "betrag" = "prozent", aktiv = true): AnkaufRegel {
  return { id: "r", bezeichnung: "R", aktiv, bedingungen, wirkung: { art, wert }, begruendung: "weil" };
}
function lauf(regeln: AnkaufRegel[], fahrzeug: Fahrzeug = auto, deckel = 30) {
  return bewerteRegeln({ fahrzeug, regeln, verkaufspreisEuro: 10000, maxGesamtAbschlagProzent: deckel, heute });
}
const trifft = (b: Bed, f: Fahrzeug = auto) => lauf([regel([b])], f).angewendet.length === 1;

describe("Operatoren", () => {
  it("gleich", () => {
    expect(trifft({ feld: "kraftstoff", op: "gleich", wert: "diesel" })).toBe(true);
    expect(trifft({ feld: "kraftstoff", op: "gleich", wert: "benzin" })).toBe(false);
  });
  it("ungleich", () => {
    expect(trifft({ feld: "kraftstoff", op: "ungleich", wert: "benzin" })).toBe(true);
    expect(trifft({ feld: "kraftstoff", op: "ungleich", wert: "diesel" })).toBe(false);
  });
  it("kleiner", () => {
    expect(trifft({ feld: "kilometer", op: "kleiner", wert: 200000 })).toBe(true);
    expect(trifft({ feld: "kilometer", op: "kleiner", wert: 150000 })).toBe(false);
  });
  it("groesser", () => {
    expect(trifft({ feld: "kilometer", op: "groesser", wert: 100000 })).toBe(true);
    expect(trifft({ feld: "kilometer", op: "groesser", wert: 150000 })).toBe(false);
  });
  it("zwischen (inklusive Grenzen)", () => {
    expect(trifft({ feld: "kilometer", op: "zwischen", von: 150000, bis: 160000 })).toBe(true);
    expect(trifft({ feld: "kilometer", op: "zwischen", von: 1, bis: 149999 })).toBe(false);
  });
  it("enthaelt auf Array und Text", () => {
    expect(trifft({ feld: "ausstattung", op: "enthaelt", wert: "navi" })).toBe(true);
    expect(trifft({ feld: "ausstattung", op: "enthaelt", wert: "Leder" })).toBe(false);
    expect(trifft({ feld: "modell", op: "enthaelt", wert: "gol" })).toBe(true);
  });
  it("fehlt", () => {
    expect(trifft({ feld: "scheckheft", op: "fehlt" })).toBe(true);
    expect(trifft({ feld: "kilometer", op: "fehlt" })).toBe(false);
    expect(trifft({ feld: "ausstattung", op: "fehlt" })).toBe(false);
    expect(trifft({ feld: "ausstattung", op: "fehlt" }, { ...auto, ausstattung: [] })).toBe(true);
  });
  it("abgeleitetes alterJahre", () => {
    expect(trifft({ feld: "alterJahre", op: "groesser", wert: 9 })).toBe(true);
    expect(trifft({ feld: "alterJahre", op: "groesser", wert: 10 })).toBe(false);
  });
});

describe("fehlende Felder", () => {
  const ohne: Fahrzeug = { marke: "VW", modell: "Golf", ausstattung: [] };
  it("erfüllen nur `fehlt`", () => {
    const bedingungen: Bed[] = [
      { feld: "kilometer", op: "kleiner", wert: 1e9 },
      { feld: "kilometer", op: "groesser", wert: -1 },
      { feld: "kilometer", op: "zwischen", von: -1, bis: 1e9 },
      { feld: "kraftstoff", op: "ungleich", wert: "benzin" },
      { feld: "ausstattung", op: "enthaelt", wert: "x" },
      { feld: "alterJahre", op: "groesser", wert: -1 },
    ];
    for (const b of bedingungen) expect(trifft(b, ohne)).toBe(false);
    expect(trifft({ feld: "alterJahre", op: "fehlt" }, ohne)).toBe(true);
  });
});

describe("Verknüpfung und Wirkung", () => {
  it("UND-verknüpft, leer gilt immer, inaktiv übersprungen", () => {
    const a: Bed = { feld: "kraftstoff", op: "gleich", wert: "diesel" };
    const b: Bed = { feld: "kilometer", op: "kleiner", wert: 1000 };
    expect(lauf([regel([a, b])]).angewendet).toHaveLength(0);
    expect(lauf([regel([a, a])]).angewendet).toHaveLength(1);
    expect(lauf([regel([])]).angewendet).toHaveLength(1);
    expect(lauf([regel([], 10, "prozent", false)]).angewendet).toHaveLength(0);
  });
  it("Prozent vom Verkaufspreis, Betrag direkt, mit Begründung", () => {
    const e = lauf([regel([], 5), regel([], 200, "betrag")]);
    expect(e.angewendet.map((x) => x.betragEuro)).toEqual([500, 200]);
    expect(e.angewendet[0]?.begruendung).toBe("weil");
    expect(e.gesamtAbschlagEuro).toBe(700);
    expect(e.gedeckelt).toBe(false);
  });
});

describe("Deckel", () => {
  it("kappt die Summe auf maxGesamtAbschlagProzent", () => {
    const e = lauf([regel([], 20), regel([], 20)], auto, 30);
    expect(e.abschlagVorDeckelEuro).toBe(4000);
    expect(e.gesamtAbschlagEuro).toBe(3000);
    expect(e.gedeckelt).toBe(true);
  });
  it("Deckel 0 erlaubt keinen Abschlag", () => {
    expect(lauf([regel([], 20)], auto, 0).gesamtAbschlagEuro).toBe(0);
  });
});
