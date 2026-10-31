import { describe, expect, it } from "vitest";
import { AuslesenErgebnisSchema, EinordnungSchema, EINORDNUNGEN, KEINE_KI } from "./ki.js";

describe("KEINE_KI", () => {
  it("kann nichts und liefert überall null", async () => {
    expect(KEINE_KI.name).toBe("keine");
    expect(KEINE_KI.kann("freitext_auslesen")).toBe(false);
    expect(await KEINE_KI.freitextAuslesen("x")).toBeNull();
    expect(await KEINE_KI.dokumentAuslesen({ mime: "image/png", daten: new ArrayBuffer(0) })).toBeNull();
    expect(await KEINE_KI.anfrageEinordnen("x")).toBeNull();
    expect(await KEINE_KI.berichtFormulieren({ sprache: "de", fahrzeug: {} as never, zahlen: {}, begruendungen: [] })).toBeNull();
  });
});

describe("KI-Schemas", () => {
  it("Einordnung nimmt nur bekannte Werte", () => {
    for (const e of EINORDNUNGEN) expect(EinordnungSchema.safeParse(e).success).toBe(true);
    expect(EinordnungSchema.safeParse("anderes").success).toBe(false);
  });

  it("Auslesen-Ergebnis begrenzt Sicherheit auf 0..1", () => {
    expect(AuslesenErgebnisSchema.safeParse({ fahrzeug: {}, sicherheit: { marke: 0.5 } }).success).toBe(true);
    expect(AuslesenErgebnisSchema.safeParse({ fahrzeug: {}, sicherheit: { marke: 1.5 } }).success).toBe(false);
  });
});
