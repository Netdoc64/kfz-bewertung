import { describe, expect, it } from "vitest";
import { EINSTELLUNGEN, EINSTELLUNGS_SCHLUESSEL } from "./einstellungen.js";
import { FEHLER } from "./fehler.js";
import { AKTIONEN, STATUS, moeglicheAktionen, uebergang } from "./status.js";
import { FahrzeugSchema } from "./fahrzeug.js";

describe("Einstellungs-Registry", () => {
  it.each(EINSTELLUNGS_SCHLUESSEL)("Standardwert von %s passt zum eigenen Schema", (k) => {
    const d = EINSTELLUNGEN[k];
    expect(d.schema.safeParse(d.standard).success).toBe(true);
    expect(d.beschreibung.length).toBeGreaterThan(10);
  });

  it("Ankaufsregel-IDs sind eindeutig", () => {
    const ids = EINSTELLUNGEN["ankauf.regeln"].standard.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("jeder Status hat eine Beschriftung", () => {
    const b = EINSTELLUNGEN["ablauf.statusBeschriftungen"].standard;
    for (const s of STATUS) expect(b[s], s).toBeTruthy();
  });

  it("die Freigabepflicht lässt sich nicht abschalten", () => {
    expect(EINSTELLUNGEN["ablauf.freigabePflicht"].schema.safeParse(false).success).toBe(false);
  });
});

describe("Fehlerkatalog", () => {
  it("nutzt nur Fehler-Status 4xx/5xx", () => {
    for (const [code, f] of Object.entries(FEHLER)) {
      expect(f.status, code).toBeGreaterThanOrEqual(400);
      expect(f.status, code).toBeLessThan(600);
    }
  });
});

describe("Statusmaschine", () => {
  it("Aktionsnamen sind je Auslöser eindeutig", () => {
    const keys = AKTIONEN.map((a) => `${a.durch}:${a.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("zum Kunden geht nichts ohne Freigabe", () => {
    expect(uebergang("zur_freigabe", "angebot_senden", "admin")).toBeNull();
    expect(uebergang("in_bewertung", "freigeben", "admin")).toBeNull();
    expect(uebergang("freigegeben", "angebot_senden", "admin")).toBe("angebot_versendet");
  });

  it("das System kann nicht freigeben", () => {
    expect(uebergang("zur_freigabe", "freigeben", "system")).toBeNull();
  });

  it("Endstatus haben keine Aktionen mehr", () => {
    expect(moeglicheAktionen("angekauft")).toEqual([]);
    expect(moeglicheAktionen("abgesagt")).toEqual([]);
  });

  it("jeder Nicht-Endstatus ist erreichbar", () => {
    const erreichbar = new Set<string>(["eingegangen", ...AKTIONEN.map((a) => a.nach)]);
    for (const s of STATUS) expect(erreichbar.has(s), s).toBe(true);
  });
});

describe("Fahrzeug", () => {
  it("lehnt FIN mit I/O/Q ab und normalisiert Großschreibung", () => {
    expect(FahrzeugSchema.safeParse({ marke: "VW", modell: "Golf", fin: "WVWZZZ1KZAW00000I" }).success).toBe(false);
    const ok = FahrzeugSchema.parse({ marke: "VW", modell: "Golf", fin: "wvwzzz1kzaw000001" });
    expect(ok.fin).toBe("WVWZZZ1KZAW000001");
  });
});
