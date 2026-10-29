import { FEHLER, SCHWERE_RANG, type Schwere } from "@kfz/shared";
import type { AppFehler } from "./app-fehler.js";

const SCHWAERZEN = /token|secret|geheim|schluessel|key|passwort|password|auth|cookie|telefon|phone|email|mail|kontakt|fin|kennzeichen/i;
const MAX_TIEFE = 4;

/** Entfernt Geheimnisse und Personendaten aus dem Kontext — rekursiv, nach Schlüsselname. */
export function schwaerzen(wert: unknown, tiefe = 0): unknown {
  if (tiefe > MAX_TIEFE) return "[zu tief]";
  if (Array.isArray(wert)) return wert.map((w) => schwaerzen(w, tiefe + 1));
  if (wert && typeof wert === "object") {
    const aus: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wert)) aus[k] = SCHWAERZEN.test(k) ? "[geschwärzt]" : schwaerzen(v, tiefe + 1);
    return aus;
  }
  if (typeof wert === "string" && wert.length > 500) return `${wert.slice(0, 500)}…`;
  return wert;
}

/** Zahlen, UUIDs und Hex-IDs raus, damit gleiche Fehler denselben Abdruck bekommen. */
function normalisieren(nachricht: string): string {
  return nachricht
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>");
}

async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FehlerMeldung {
  fehler: AppFehler;
  ort: string;
  korrelationsId: string;
}

export async function fingerabdruck(code: string, ort: string, nachricht: string): Promise<string> {
  return sha256(`${code}|${ort}|${normalisieren(nachricht)}`);
}

/**
 * Legt den Fehler ab oder zählt ihn hoch. Wirft nie — ein kaputter
 * Fehlerspeicher darf die eigentliche Antwort nicht verhindern.
 */
export async function fehlerSpeichern(db: D1Database, m: FehlerMeldung, abSchwere: Schwere): Promise<void> {
  const def = FEHLER[m.fehler.code];
  if (SCHWERE_RANG[def.schwere] < SCHWERE_RANG[abSchwere]) return;
  try {
    const abdruck = await fingerabdruck(m.fehler.code, m.ort, m.fehler.message);
    const kontext = m.fehler.kontext ? JSON.stringify(schwaerzen(m.fehler.kontext)) : null;
    await db
      .prepare(
        `INSERT INTO fehler_ereignisse (fingerabdruck, code, schwere, ort, nachricht, kontext, letzte_korrelation)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (fingerabdruck) DO UPDATE SET
           anzahl = anzahl + 1,
           zuletzt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           letzte_korrelation = excluded.letzte_korrelation,
           kontext = excluded.kontext,
           quittiert_am = NULL,
           quittiert_von = NULL`,
      )
      .bind(abdruck, m.fehler.code, def.schwere, m.ort, m.fehler.message.slice(0, 1000), kontext, m.korrelationsId)
      .run();
  } catch (e) {
    // Letzte Instanz: nur noch ins Worker-Log, ohne Kontext.
    console.error("Fehlerspeicher nicht erreichbar", { code: m.fehler.code, korrelationsId: m.korrelationsId, grund: String(e) });
  }
}
