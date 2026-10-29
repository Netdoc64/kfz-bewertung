import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import type { Kanal } from "./kanal.js";

export { MockKanal, type AusgehendeNachricht, type Kanal } from "./kanal.js";

/** Status, ab denen ein Admin die Bewertung freigegeben hat (Statusmaschine, keine Fachzahl). */
const FREIGEGEBEN = ["freigegeben", "angebot_versendet", "verhandlung", "besichtigung"];

export interface Versandauftrag {
  kanal: Kanal;
  /** Empfänger (Adresse oder Nummer). */
  an: string;
  /** Anlass = Schlüssel in `antwort.vorlagen`, z. B. eingang, rueckfrage, angebot. */
  anlass: string;
  anfrageId?: string;
  /** Sprache des Kunden; sonst `antwort.standardSprache`. */
  sprache?: string;
  werte?: Record<string, string>;
  korrelation: string;
  /** Idempotenz: gleicher Schlüssel + bereits gesendet → keine zweite Nachricht. */
  schluessel?: string;
}

export interface Versandergebnis {
  id: string;
  status: "gesendet" | "geparkt";
  inhalt: string;
  datenschutzAngehaengt: boolean;
  /** true, wenn der Schlüssel schon eine gesendete Nachricht hatte. */
  wiederholung: boolean;
}

interface Zeile {
  id: string;
  inhalt: string;
  datenschutz_angehaengt: number;
}

function fuelle(vorlage: string, werte: Record<string, string>, anlass: string): string {
  return vorlage.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const w = werte[name];
    if (w === undefined) throw new AppFehler("VERSAND_FEHLGESCHLAGEN", `Platzhalter ${name} ohne Wert`, { kontext: { anlass, platzhalter: name } });
    return w;
  });
}

/**
 * Gemeinsamer Ausgang aller Kanäle. Reihenfolge: Not-Aus lesen, Freigabe
 * prüfen, Text aus der Vorlage bauen, dann senden oder parken. Jeder Versuch
 * landet in `nachrichten`.
 */
export async function sende(db: D1Database, einstellungen: Einstellungen, a: Versandauftrag): Promise<Versandergebnis> {
  if (a.schluessel) {
    const alt = await db
      .prepare("SELECT id, inhalt, datenschutz_angehaengt FROM nachrichten WHERE schluessel = ?1 AND status = 'gesendet'")
      .bind(a.schluessel)
      .first<Zeile>();
    if (alt) return { id: alt.id, status: "gesendet", inhalt: alt.inhalt, datenschutzAngehaengt: alt.datenschutz_angehaengt === 1, wiederholung: true };
  }

  const autopilot = await einstellungen.lese("ablauf.autopilot");
  const erlaubt: string[] = await einstellungen.lese("antwort.automatischErlaubt");

  if (!erlaubt.includes(a.anlass)) {
    const row = a.anfrageId ? await db.prepare("SELECT status FROM anfragen WHERE id = ?1").bind(a.anfrageId).first<{ status: string }>() : null;
    if (!row || !FREIGEGEBEN.includes(row.status)) {
      throw new AppFehler("FREIGABE_FEHLT", undefined, { kontext: { anlass: a.anlass, anfrageId: a.anfrageId } });
    }
  }

  const standardSprache = await einstellungen.lese("antwort.standardSprache");
  const sprache = a.sprache ?? standardSprache;
  const vorlagen = await einstellungen.lese("antwort.vorlagen");
  const tabelle = vorlagen[sprache] ?? vorlagen[standardSprache];
  const vorlage = tabelle?.[a.anlass];
  if (!tabelle || !vorlage) throw new AppFehler("VERSAND_FEHLGESCHLAGEN", `Keine Vorlage für ${a.anlass}`, { kontext: { anlass: a.anlass, sprache } });
  const werte = a.werte ?? {};
  let inhalt = fuelle(vorlage, werte, a.anlass);

  // A14: die erste gesendete Nachricht an einen Kontakt trägt den Datenschutzhinweis.
  let datenschutz = a.anlass === "datenschutz";
  if (!datenschutz && tabelle.datenschutz) {
    const schon = await db
      .prepare("SELECT 1 AS x FROM nachrichten WHERE kontakt = ?1 AND status = 'gesendet' AND datenschutz_angehaengt = 1 LIMIT 1")
      .bind(a.an)
      .first();
    if (!schon) {
      inhalt = `${inhalt}\n\n${fuelle(tabelle.datenschutz, werte, "datenschutz")}`;
      datenschutz = true;
    }
  }

  const { abdruck } = await einstellungen.abdruck();
  const id = crypto.randomUUID();
  const speichern = (status: "gesendet" | "geparkt" | "fehlgeschlagen", extra: { externeId?: string; fehlerCode?: string } = {}) =>
    db
      .prepare(
        `INSERT INTO nachrichten (id, anfrage_id, kontakt, kanal, anlass, vorlage, sprache, inhalt, status, datenschutz_angehaengt, autopilot, einstellungs_abdruck, korrelation, externe_id, fehler_code, schluessel)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .bind(
        id,
        a.anfrageId ?? null,
        a.an,
        a.kanal.name,
        a.anlass,
        a.anlass,
        sprache,
        inhalt,
        status,
        datenschutz ? 1 : 0,
        autopilot,
        abdruck,
        a.korrelation,
        extra.externeId ?? null,
        extra.fehlerCode ?? null,
        status === "gesendet" ? (a.schluessel ?? null) : null,
      )
      .run();

  if (autopilot !== "an") {
    await speichern("geparkt");
    if (autopilot === "aus") throw new AppFehler("AUTOPILOT_GESPERRT", undefined, { kontext: { anlass: a.anlass, nachrichtId: id } });
    return { id, status: "geparkt", inhalt, datenschutzAngehaengt: datenschutz, wiederholung: false };
  }

  try {
    const r = await a.kanal.sende({ an: a.an, text: inhalt, korrelation: a.korrelation });
    await speichern("gesendet", { externeId: r.externeId });
  } catch (e) {
    await speichern("fehlgeschlagen", { fehlerCode: "VERSAND_FEHLGESCHLAGEN" });
    throw new AppFehler("VERSAND_FEHLGESCHLAGEN", undefined, { ursache: e, kontext: { anlass: a.anlass, kanal: a.kanal.name } });
  }
  return { id, status: "gesendet", inhalt, datenschutzAngehaengt: datenschutz, wiederholung: false };
}
