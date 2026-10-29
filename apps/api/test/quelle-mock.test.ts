import { SuchStufeSchema, type Fahrzeug, type SuchStufe } from "@kfz/shared";
import { describe, expect, it } from "vitest";
import { AppFehler } from "../src/fehler/app-fehler.js";
import { waehleQuelle } from "../src/quelle/index.js";
import { MockSuche } from "../src/quelle/mock.js";

const STUFEN: SuchStufe[] = [
  { ezToleranzJahre: 0, kmToleranzProzent: 15, umkreisKm: 200, leistungToleranzProzent: 5 },
  { ezToleranzJahre: 1, kmToleranzProzent: 25, umkreisKm: 500, leistungToleranzProzent: 10 },
  { ezToleranzJahre: 2, kmToleranzProzent: 40, umkreisKm: null, leistungToleranzProzent: 15 },
].map((s) => SuchStufeSchema.parse(s));

const polo: Fahrzeug = { marke: "VW", modell: "Polo", kraftstoff: "benzin", erstzulassung: "2020-06", kilometer: 50000, leistungKw: 70, ausstattung: [] };
const golf: Fahrzeug = { marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] };
const tesla: Fahrzeug = { marke: "Tesla", modell: "Model 3", kraftstoff: "elektro", erstzulassung: "2020-08", kilometer: 64000, leistungKw: 211, ausstattung: [] };

describe("Mock-mobile.de", () => {
  const quelle = new MockSuche();

  it.each([
    ["Kleinwagen Benzin", polo, "kleinwagen_benzin"],
    ["Kompakt Diesel", golf, "kompakt_diesel"],
    ["E-Auto", tesla, "e_auto"],
  ])("liefert Treffer nur aus dem Segment %s", async (_name, fahrzeug, praefix) => {
    const t = await quelle.suche(fahrzeug, STUFEN[2]!);
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((i) => i.id.startsWith(praefix))).toBe(true);
  });

  it("weitere Stufen liefern mehr Treffer", async () => {
    for (const f of [polo, golf, tesla]) {
      const n: number[] = [];
      for (const s of STUFEN) n.push((await quelle.suche(f, s)).length);
      expect(n[1]).toBeGreaterThan(n[0]!);
      expect(n[2]).toBeGreaterThan(n[1]!);
    }
  });

  it("enthält Ausreißer sowie Netto- und Bruttopreise", async () => {
    const t = await quelle.suche(polo, STUFEN[0]!);
    expect(t.some((i) => i.preisBruttoEuro === 1)).toBe(true);
    expect(t.some((i) => /export/i.test(i.titel))).toBe(true);
    expect(t.some((i) => /leasing/i.test(i.titel))).toBe(true);
    expect(t.some((i) => i.preisNettoEuro !== undefined)).toBe(true);
    expect(t.some((i) => i.preisNettoEuro === undefined)).toBe(true);
  });

  it("ist deterministisch", async () => {
    const a = await quelle.suche(golf, STUFEN[1]!);
    const b = await new MockSuche().suche(golf, STUFEN[1]!);
    expect(b).toEqual(a);
  });

  it("unbekanntes Modell liefert nichts", async () => {
    expect(await quelle.suche({ ...polo, modell: "Phantom" }, STUFEN[2]!)).toEqual([]);
  });

  it("Formatfehler wirft QUELLE_ANTWORT_UNGUELTIG", async () => {
    const kaputt = new MockSuche([{ schluessel: "kaputt", inserate: [{ id: "x", titel: "Polo" }] }]);
    await expect(kaputt.suche(polo, STUFEN[0]!)).rejects.toMatchObject({ code: "QUELLE_ANTWORT_UNGUELTIG" });
  });
});

describe("Adapter-Wähler", () => {
  const mit = (modus: "mock" | "live") => ({ lese: async () => modus }) as never;

  it("mock liefert die MockSuche", async () => {
    expect(await waehleQuelle(mit("mock"))).toBeInstanceOf(MockSuche);
  });

  it("live meldet einen Katalogfehler statt zu raten", async () => {
    const e = await waehleQuelle(mit("live")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppFehler);
    expect((e as AppFehler).code).toBe("QUELLE_ZUGANG");
  });
});
