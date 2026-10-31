import { sendeAdminMail } from "../alarm/absender.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler, alsAppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import type { PushAnschluss } from "../push/port.js";

/** Stufen der Freigabe-Benachrichtigung (A3), aufsteigend. */
export const STUFEN = ["neu", "erinnerung", "eskalation"] as const;
export type Stufe = (typeof STUFEN)[number];

export interface FreigabeAnfrage {
  id: string;
  generation: number;
  /** JSON der Spalte `anfragen.fahrzeug`. */
  fahrzeug: string;
}

function fahrzeugText(json: string): string {
  try {
    const f = JSON.parse(json) as { marke?: unknown; modell?: unknown };
    return [f.marke, f.modell].filter((s): s is string => typeof s === "string").join(" ") || "Fahrzeug";
  } catch {
    return "Fahrzeug";
  }
}

function fuelle(vorlage: string, werte: Record<string, string>): string {
  return vorlage.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => werte[name] ?? "");
}

/**
 * Meldet eine offene Freigabe dem Admin, je Anfrage, Generation und Stufe genau einmal.
 * Die Stufe wird zuerst beansprucht (PRIMARY KEY), dann gesendet; scheitert der Versand,
 * wird der Anspruch zurückgenommen, damit der nächste Lauf es erneut versucht.
 * Der Kanal `whatsapp` ist für Admin-Meldungen nicht angebunden: es geht per E-Mail raus,
 * statt dass die Freigabe unbemerkt liegen bleibt. Mit `aus` passiert nichts.
 * Mit `push` (und `push.aktiv`) geht nach der Mail zusätzlich ein Push an jedes nicht widerrufene,
 * nicht abgelaufene Gerät mit Push-Token; ein Push-Fehler landet als PUSH_FEHLGESCHLAGEN im Fehlerspeicher
 * und ändert am Ergebnis nichts.
 * Gibt true zurück, wenn jetzt gesendet wurde.
 */
export async function meldeFreigabe(
  db: D1Database,
  einstellungen: Einstellungen,
  email: SendEmail,
  anfrage: FreigabeAnfrage,
  stufe: Stufe,
  stunden: number,
  push?: PushAnschluss,
): Promise<boolean> {
  if ((await einstellungen.lese("benachrichtigung.kanal")) === "aus") return false;
  const texte = (await einstellungen.lese("benachrichtigung.texte"))[stufe];
  if (!texte) throw new AppFehler("EINSTELLUNG_UNGUELTIG", `benachrichtigung.texte ohne Eintrag für ${stufe}`);

  const anspruch = await db
    .prepare("INSERT OR IGNORE INTO freigabe_benachrichtigungen (anfrage_id, generation, stufe) VALUES (?1, ?2, ?3)")
    .bind(anfrage.id, anfrage.generation, stufe)
    .run();
  if (!anspruch.meta.changes) return false;

  const werte = { anfrage: anfrage.id, fahrzeug: fahrzeugText(anfrage.fahrzeug), stunden: String(Math.floor(stunden)) };
  try {
    await sendeAdminMail(email, einstellungen, { betreff: fuelle(texte.betreff, werte), text: fuelle(texte.text, werte) });
  } catch (e) {
    await db
      .prepare("DELETE FROM freigabe_benachrichtigungen WHERE anfrage_id = ?1 AND generation = ?2 AND stufe = ?3")
      .bind(anfrage.id, anfrage.generation, stufe)
      .run();
    throw e;
  }
  if (push) await pushAnGeraete(db, einstellungen, email, push, stufe, werte, anfrage.id);
  return true;
}

async function pushAnGeraete(
  db: D1Database,
  einstellungen: Einstellungen,
  email: SendEmail,
  push: PushAnschluss,
  stufe: Stufe,
  werte: Record<string, string>,
  anfrageId: string,
): Promise<void> {
  try {
    if (!(await einstellungen.lese("push.aktiv"))) return;
    const texte = (await einstellungen.lese("push.texte"))[stufe];
    if (!texte) return;
    const { results } = await db
      .prepare("SELECT id, push_token FROM geraete WHERE widerrufen_am IS NULL AND ablauf_am > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND push_token IS NOT NULL AND push_token != ''")
      .all<{ id: string; push_token: string }>();
    for (const g of results) {
      try {
        await push.sende(g.push_token, fuelle(texte.titel, werte), fuelle(texte.text, werte));
      } catch (e) {
        const f = e instanceof AppFehler && e.code === "PUSH_FEHLGESCHLAGEN" ? e : new AppFehler("PUSH_FEHLGESCHLAGEN", undefined, { ursache: e, kontext: { anfrageId, geraetId: g.id } });
        await fehlerSpeichern(db, { fehler: f, ort: "benachrichtigung:push", korrelationsId: anfrageId }, "info", email);
      }
    }
  } catch (e) {
    await fehlerSpeichern(db, { fehler: alsAppFehler(e), ort: "benachrichtigung:push", korrelationsId: anfrageId }, "info", email);
  }
}

/** Hält eine Stufe als erledigt fest, ohne zu senden (übersprungene Vorstufe). */
export async function ueberspringeStufe(db: D1Database, anfrage: FreigabeAnfrage, stufe: Stufe): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO freigabe_benachrichtigungen (anfrage_id, generation, stufe) VALUES (?1, ?2, ?3)")
    .bind(anfrage.id, anfrage.generation, stufe)
    .run();
}
