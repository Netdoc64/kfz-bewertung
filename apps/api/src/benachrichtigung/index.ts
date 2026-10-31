import { sendeAdminMail } from "../alarm/absender.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";

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
 * Gibt true zurück, wenn jetzt gesendet wurde.
 */
export async function meldeFreigabe(
  db: D1Database,
  einstellungen: Einstellungen,
  email: SendEmail,
  anfrage: FreigabeAnfrage,
  stufe: Stufe,
  stunden: number,
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
  return true;
}

/** Hält eine Stufe als erledigt fest, ohne zu senden (übersprungene Vorstufe). */
export async function ueberspringeStufe(db: D1Database, anfrage: FreigabeAnfrage, stufe: Stufe): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO freigabe_benachrichtigungen (anfrage_id, generation, stufe) VALUES (?1, ?2, ?3)")
    .bind(anfrage.id, anfrage.generation, stufe)
    .run();
}
