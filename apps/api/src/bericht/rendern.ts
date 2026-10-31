import type { EinstellungsWert, Fahrzeug } from "@kfz/shared";
import { AppFehler } from "../fehler/app-fehler.js";
import type { Bewertung } from "../bewertung/bewerten.js";

export type BerichtVorlagen = EinstellungsWert<"bericht.vorlagen">;

export interface RenderEingabe {
  fahrzeug: Fahrzeug;
  bewertung: Bewertung;
  vorlagen: BerichtVorlagen;
  sprache: string;
  gueltigBis: Date;
}

export interface Gerendert {
  /** Tatsächlich verwendete Sprache (Rückfall, wenn `sprache` keine Vorlage hat). */
  sprache: string;
  betreff: string;
  html: string;
}

type Werte = Record<string, { text: string; roh?: boolean }>;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** Wählt die Vorlage: gewünschte Sprache, sonst "de", sonst die erste vorhandene. */
export function waehleVorlage(vorlagen: BerichtVorlagen, sprache: string) {
  const kurz = sprache.toLowerCase().split("-")[0] ?? "";
  const schluessel = [sprache, kurz, "de"].find((k) => k in vorlagen) ?? Object.keys(vorlagen)[0];
  const vorlage = schluessel === undefined ? undefined : vorlagen[schluessel];
  if (schluessel === undefined || !vorlage) {
    throw new AppFehler("BERICHT_VORLAGE_FEHLT", undefined, { kontext: { sprache } });
  }
  return { sprache: schluessel, vorlage };
}

function euro(wert: number | null | undefined, sprache: string): string {
  if (wert === null || wert === undefined) return "";
  return new Intl.NumberFormat(sprache, { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(wert);
}

function zahl(wert: number | null | undefined, sprache: string): string {
  if (wert === null || wert === undefined) return "";
  return new Intl.NumberFormat(sprache).format(wert);
}

function fahrzeugText(f: Fahrzeug, sprache: string): string {
  const teile = [f.marke, f.modell, f.variante, f.erstzulassung, f.kilometer === undefined ? undefined : `${zahl(f.kilometer, sprache)} km`];
  return teile.filter((t): t is string => !!t).join(" ");
}

function datum(d: Date, sprache: string): string {
  return new Intl.DateTimeFormat(sprache, { dateStyle: "medium", timeZone: "UTC" }).format(d);
}

/**
 * Platzhalter und ihr Inhalt. Klartext wird escaped, `roh` ist bereits escaptes HTML.
 * Beschriftungen stehen in der Vorlage, nicht hier.
 */
function platzhalter(e: RenderEingabe, hinweis: string, sprache: string): Werte {
  const b = e.bewertung;
  const stufe = b.suchStufe;
  const t = (text: string) => ({ text });
  const zeilen = b.vergleiche
    .map(
      (v) =>
        `<tr><td>${htmlEscape(euro(v.preisEuro, sprache))}</td><td>${htmlEscape(zahl(v.kilometer, sprache))}</td>` +
        `<td>${htmlEscape(v.erstzulassung ?? "")}</td></tr>`,
    )
    .join("");
  const regelnListe = (b.regeln?.angewendet ?? [])
    .map((r) => `<li>${htmlEscape(r.bezeichnung)}: ${htmlEscape(euro(r.betragEuro, sprache))} (${htmlEscape(r.begruendung)})</li>`)
    .join("");
  return {
    fahrzeug: t(fahrzeugText(e.fahrzeug, sprache)),
    ankaufVon: t(euro(b.spanne?.vonEuro, sprache)),
    ankaufBis: t(euro(b.spanne?.bisEuro, sprache)),
    ankaufspreis: t(euro(b.ankaufspreisEuro, sprache)),
    marktpreis: t(euro(b.marktpreisEuro, sprache)),
    verkaufspreis: t(euro(b.verkaufspreisEuro, sprache)),
    anzahlVergleiche: t(zahl(b.anzahlVergleiche, sprache)),
    konfidenzProzent: t(zahl(Math.round(b.konfidenz * 100), sprache)),
    suchstufeNr: t(b.stufe === null ? "" : String(b.stufe + 1)),
    suchstufeAnzahl: t(String(b.versuche.length)),
    suchstufeEzJahre: t(stufe ? zahl(stufe.ezToleranzJahre, sprache) : ""),
    suchstufeKmProzent: t(stufe ? zahl(stufe.kmToleranzProzent, sprache) : ""),
    suchstufeLeistungProzent: t(stufe ? zahl(stufe.leistungToleranzProzent, sprache) : ""),
    suchstufeUmkreisKm: t(stufe ? (stufe.umkreisKm === null ? "–" : zahl(stufe.umkreisKm, sprache)) : ""),
    gueltigBis: t(datum(e.gueltigBis, sprache)),
    hinweis: t(hinweis),
    vergleichsZeilen: { text: zeilen, roh: true },
    regelnListe: { text: regelnListe, roh: true },
  };
}

function ersetze(text: string, werte: Werte, alsHtml: boolean): string {
  // Ein Durchgang: eingesetzte Werte werden nie erneut auf Platzhalter durchsucht.
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    const w = werte[name];
    if (!w) return "";
    return alsHtml && !w.roh ? htmlEscape(w.text) : w.text;
  });
}

/** Rendert den Bericht aus der Vorlage. Der Hinweis „kein Gutachten“ steht immer drin. */
export function rendereBericht(e: RenderEingabe): Gerendert {
  const { sprache, vorlage } = waehleVorlage(e.vorlagen, e.sprache);
  const werte = platzhalter(e, vorlage.hinweis, sprache);
  let html = ersetze(vorlage.html, werte, true);
  if (!/\{\{\s*hinweis\s*\}\}/.test(vorlage.html)) html += `<p><small>${htmlEscape(vorlage.hinweis)}</small></p>`;
  return { sprache, betreff: ersetze(vorlage.betreff, werte, false), html };
}
