// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { rendere, rendereKopplung } from "../src/ansicht.js";
import { Steuerung, type Zustand } from "../src/steuerung.js";
import { istAktivierung } from "../src/tastatur.js";
import type { Api, Anfrage, Detail, Kennzahlen } from "../src/api.js";

const anfrage: Anfrage = {
  id: "a1", kanal: "app", status: "zur_freigabe", statusText: "Wartet auf Freigabe", version: 2, kunde_name: "Max", kunde_kontakt: null,
  fahrzeug: { marke: "VW", modell: "Golf" }, erstellt_am: "2026-01-01T10:00:00Z", geaendert_am: "2026-01-02T10:00:00Z",
};
const dauer = { anzahl: 2, mittel: 3600, median: 3600, max: 7200 };
const kennzahlen: Kennzahlen = {
  zeitraum: { von: "2026-01-01", bis: "2026-01-31" }, anfragen: 3, durchlaufzeit: { zur_freigabe: dauer, offen: 1 },
  anMensch: { anzahl: 1, anteil: 0.3, mitGrund: 1, anteilMitGrund: 1, gruende: { unklar: 1 } },
  konfidenz: { berichte: 2, mittel: 0.8, klassen: [{ von: null, bis: 0.5, anzahl: 1 }, { von: 0.5, bis: null, anzahl: 1 }] },
  fehlerrate: { bewertungen: 3, fehlgeschlagen: 0, rate: 0 }, freigabedauer: dauer,
  ki: { aufrufe: 1, anfragen: 1, tokenEin: 10, tokenAus: 5, kostenEuro: 0.01, kostenJeAnfrage: 0.01, faehigkeiten: { auslesen: { aufrufe: 1, tokenEin: 10, tokenAus: 5, kostenEuro: 0.01 } } },
};
const detail: Detail = {
  anfrage,
  ereignisse: [{ id: 1, aktion: "x", status_von: null, status_nach: "zur_freigabe", statusNachText: "Wartet", durch: "system", notiz: "ok", am: "2026-01-01T10:00:00Z" }],
  nachrichten: [{ id: "n1", kanal: "app", anlass: "eingang", inhalt: "Hallo", status: "gesendet", erstellt_am: "2026-01-01T10:00:00Z" }],
  kundenNachrichten: [{ id: 1, kanal: "app", text: "Hi", erstellt_am: "2026-01-01T10:00:00Z" }],
  bericht: { generation: 1, gueltigBis: "2026-02-01T00:00:00Z", html: "<p>Bericht</p>" },
  aktionen: [
    { name: "ankauf_abschliessen", nach: "angekauft", nachText: "Ankauf abschließen" },
    { name: "ablehnen", nach: "abgelehnt", nachText: "Ablehnen" },
  ] as Detail["aktionen"],
};
const vorschau = {
  schluessel: "bewertung.x", anzahl: 1, geaendert: 1,
  zeilen: [{
    anfrageId: "a1", generation: 1, ankaufDifferenzEuro: 100, geaendert: true,
    vorher: { marktpreisEuro: 1, verkaufspreisEuro: 1, ankaufspreisEuro: 1000, konfidenz: 1, anzahlVergleiche: 3, anMenschGruende: [] },
    nachher: { marktpreisEuro: 1, verkaufspreisEuro: 1, ankaufspreisEuro: 1100, konfidenz: 1, anzahlVergleiche: 3, anMenschGruende: ["a"] },
  }],
};

const basis = new Steuerung({} as Api, () => {}).zustand;
const zustand = (z: Partial<Zustand>): Zustand => ({
  ...basis,
  statusNamen: { zur_freigabe: "Wartet auf Freigabe" },
  liste: { eintraege: [anfrage], seite: 1, proSeite: 25, gesamt: 1 },
  ...z,
});

const geparkt = (id: string, kanal: string, grund: string, nutzlast: Record<string, string> | null) => ({
  id, kontakt: `${id}@example.test`, kanal, nutzlast, grund, erstellt_am: "2026-01-01T00:00:00Z", geprueft_am: null, geprueft_von: null, entscheidung: null, anfrage_id: null,
});

const ansichten: Record<string, Partial<Zustand>> = {
  liste: { ansicht: "liste" },
  "liste mit Meldung": { ansicht: "liste", meldung: { art: "fehler", code: "X", text: "Kaputt", korrelationsId: "k1" } },
  laden: { ansicht: "liste", liste: null, laedt: true },
  detail: { ansicht: "detail", detail },
  einstellungen: {
    ansicht: "einstellungen",
    einstellungen: [{ schluessel: "bewertung.x", wert: 1, standard: 1, version: 1, quelle: "d1", gruppe: "bewertung", beschreibung: "Beschreibung", geaendertAm: null, geaendertVon: null }],
    bearbeitung: { schluessel: "bewertung.x", text: "1", warnungen: ["Hoch"], vorschau: { text: "1", ergebnis: vorschau } },
  },
  fehler: { ansicht: "fehler", fehlerListe: [{ id: 1, code: "E", schwere: "hoch", ort: "api", nachricht: "n", letzteKorrelation: "k", anzahl: 2, erstmals: "2026-01-01T00:00:00Z", zuletzt: "2026-01-02T00:00:00Z", quittiertAm: null }] },
  deadletter: { ansicht: "deadletter", deadLetter: [{ id: 1, nachricht_id: "m", queue: "q", anfrage_id: "a1", job_generation: 1, korrelation: "k", nutzlast: {}, versuche: 3, erstellt_am: "2026-01-01T00:00:00Z", erneut_am: null, erneut_von: null, erneut_generation: null }] },
  kennzahlen: { ansicht: "kennzahlen", kennzahlen, abweichungen: { gesamt: 2, ohneSchaetzung: 0, zeilen: [{ marke: "VW", segment: "mittel", anzahl: 2, abweichungEuro: 10, abweichungProzent: 1, belastbar: false }] } },
  geparkt: { ansicht: "geparkt", geparkt: [geparkt("g1", "email", "mail_unklar", { name: "Max", betreff: "B", text: "T" }), geparkt("g2", "formular", "flutschutz", null)] },
};

const modi = [
  { name: "Admin", appModus: false, ansichten: Object.keys(ansichten) },
  { name: "App", appModus: true, ansichten: ["liste", "liste mit Meldung", "laden", "detail"] },
];

/** Entspricht index.html: die Wurzel ist das <main>-Landmark der Seite. */
function seite(html: string): HTMLElement {
  document.body.innerHTML = `<main id="app">${html}</main>`;
  return document.getElementById("app") as HTMLElement;
}

const faelle: { name: string; html: string }[] = [
  ...modi.flatMap((m) => m.ansichten.map((a) => ({ name: `${m.name}: ${a}`, html: rendere(zustand({ ...ansichten[a], appModus: m.appModus })) }))),
  { name: "App: Kopplung", html: rendereKopplung((k) => k, null, false, "https://a.test") },
  { name: "App: Kopplung mit Fehler", html: rendereKopplung((k) => k, { code: "X", text: "falsch" }, true) },
];

describe("axe: keine Befunde der Stufen serious/critical", () => {
  it.each(faelle)("$name", async ({ html }) => {
    seite(html);
    // Kontrast braucht Layout (fehlt in jsdom) und wird unten über die Farbwerte geprüft.
    // Der Bericht-iframe ist in jsdom nicht erreichbar (axe-Frame-Kommunikation); sein Titel wird direkt geprüft.
    for (const f of Array.from(document.querySelectorAll("iframe"))) expect(f.getAttribute("title"), f.outerHTML).toBeTruthy();
    const r = await axe.run({ include: [["#app"]], exclude: [["iframe"]] }, { rules: { "color-contrast": { enabled: false } } });
    const schwer = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(schwer.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});

const bedienbar = "button, input, select, textarea, a[href], [tabindex]";

describe("Tastaturbedienung", () => {
  it.each(faelle)("$name: Bedienelemente fokussierbar, Reihenfolge = DOM-Reihenfolge", ({ html }) => {
    const wurzel = seite(html);
    const elemente = Array.from(wurzel.querySelectorAll<HTMLElement>(bedienbar));
    expect(elemente.length).toBeGreaterThan(0);
    for (const el of elemente) {
      // Kein positiver tabindex: die Tab-Reihenfolge folgt dem Dokument.
      expect(Number(el.getAttribute("tabindex") ?? 0), el.outerHTML).toBeLessThanOrEqual(0);
      if (el.hasAttribute("disabled")) continue;
      el.focus();
      expect(document.activeElement, el.outerHTML).toBe(el);
    }
  });

  it.each(faelle)("$name: Navigation steht vor dem Inhalt", ({ html }) => {
    const wurzel = seite(html);
    if (!wurzel.querySelector("nav.haupt")) return;
    expect(wurzel.querySelector<HTMLElement>(bedienbar)?.closest("nav.haupt")).not.toBeNull();
  });

  it("Tabellenzeilen sind fokussierbar und reagieren auf Enter und Leertaste", () => {
    const wurzel = seite(rendere(zustand({ ansicht: "liste" })));
    expect(wurzel.querySelector("tr[data-id]")?.getAttribute("tabindex")).toBe("0");
    expect(istAktivierung({ key: "Enter" })).toBe(true);
    expect(istAktivierung({ key: " " })).toBe(true);
    expect(istAktivierung({ key: "Tab" })).toBe(false);
    expect(istAktivierung({ key: "Enter", ctrlKey: true })).toBe(false);
  });

  it("Knöpfe sind echte <button>: Enter und Leertaste löst der Browser aus", () => {
    const wurzel = seite(rendere(zustand({ ansicht: "detail", detail })));
    const knoepfe = wurzel.querySelectorAll("[data-aktion], [data-nav], [data-zurueck]");
    expect(knoepfe.length).toBeGreaterThan(0);
    for (const k of Array.from(knoepfe)) expect(k.tagName).toBe("BUTTON");
  });
});

const css = readFileSync(resolve(__dirname, "../index.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";

const hell = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const kontrast = (a: string, b: string): number => {
  const [x, y] = [hell(a), hell(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
};
const erste = (muster: RegExp): string => css.match(muster)?.[1] ?? "";

describe("Kontrast und Fokus (WCAG AA)", () => {
  const text = erste(/body \{[^}]*?\bcolor:\s*(#[0-9a-fA-F]{6})/);
  const grund = erste(/body \{[^}]*?\bbackground:\s*(#[0-9a-fA-F]{6})/);

  it("Fließtext hat ≥ 4,5:1 auf jedem Hintergrund der Seite", () => {
    expect(text).not.toBe("");
    expect(grund).not.toBe("");
    const hintergruende = [...css.matchAll(/background:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1] as string);
    expect(hintergruende.length).toBeGreaterThan(3);
    for (const h of hintergruende) expect(kontrast(text, h), h).toBeGreaterThanOrEqual(4.5);
  });

  it("Tabellenlinien und Fokusring haben ≥ 3:1 (Nicht-Text-Kontrast)", () => {
    const linie = erste(/border-bottom:\s*1px solid (#[0-9a-fA-F]{6})/);
    const ring = erste(/:focus-visible \{[^}]*outline:\s*\d+px solid (#[0-9a-fA-F]{6})/);
    expect(linie).not.toBe("");
    expect(ring).not.toBe("");
    expect(kontrast(linie, grund)).toBeGreaterThanOrEqual(3);
    expect(kontrast(ring, grund)).toBeGreaterThanOrEqual(3);
  });

  it("Fokus bleibt sichtbar: kein outline:none", () => {
    expect(css).toMatch(/:focus-visible/);
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });
});
