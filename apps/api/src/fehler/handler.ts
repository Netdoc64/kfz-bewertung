import { EINSTELLUNGEN } from "@kfz/shared";
import { alsAppFehler } from "./app-fehler.js";
import { fehlerSpeichern } from "./speicher.js";

/**
 * Führt einen Handler außerhalb von HTTP (Queue, Cron, E-Mail) aus. Ein Fehler
 * landet im Fehlerspeicher und wird danach weitergeworfen, damit die
 * Plattform wiederholen kann — nie still.
 */
export async function mitFehlerspeicher<T>(db: D1Database, ort: string, lauf: (korrelationsId: string) => Promise<T>): Promise<T> {
  const korrelationsId = crypto.randomUUID();
  try {
    return await lauf(korrelationsId);
  } catch (e) {
    await fehlerSpeichern(db, { fehler: alsAppFehler(e), ort, korrelationsId }, EINSTELLUNGEN["betrieb.fehlerSpeichernAbSchwere"].standard);
    throw e;
  }
}
