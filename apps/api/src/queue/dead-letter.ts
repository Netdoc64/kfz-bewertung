import { alarmPruefen } from "../alarm/index.js";
import { Einstellungen } from "../einstellungen/dienst.js";
import type { Bindings } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern, fingerabdruck } from "../fehler/speicher.js";

/** Anzahl der noch nicht erneut eingereihten Einträge. */
export async function zaehleOffene(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM dead_letter WHERE erneut_am IS NULL").first<{ n: number }>();
  return r?.n ?? 0;
}

function feld(body: unknown, name: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

/**
 * Dead-Letter-Consumer: legt jeden Job in D1 ab (je Nachrichten-ID einmal, also auch bei
 * doppelter Zustellung idempotent), meldet DEAD_LETTER und alarmiert ab der Schwelle
 * `betrieb.deadLetterAlarmAb`. Wirft, wenn die Ablage scheitert — dann stellt die Queue neu zu.
 */
export async function verarbeiteDeadLetter(batch: MessageBatch<unknown>, env: Bindings, korrelationsId: string): Promise<void> {
  const einstellungen = new Einstellungen(env.DB, async () => {});
  const ort = `queue ${batch.queue}`;
  for (const nachricht of batch.messages) {
    const anfrageId = feld(nachricht.body, "anfrageId");
    const generation = feld(nachricht.body, "generation");
    const korrelation = feld(nachricht.body, "korrelation");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO dead_letter (nachricht_id, queue, anfrage_id, job_generation, korrelation, nutzlast, versuche) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(
        nachricht.id,
        batch.queue,
        typeof anfrageId === "string" ? anfrageId : null,
        typeof generation === "number" ? generation : null,
        typeof korrelation === "string" ? korrelation : null,
        JSON.stringify(nachricht.body ?? null),
        nachricht.attempts,
      )
      .run();
    nachricht.ack();

    const fehler = new AppFehler("DEAD_LETTER", "Job in der Dead-Letter-Queue", { kontext: { anfrageId: typeof anfrageId === "string" ? anfrageId : null } });
    await fehlerSpeichern(env.DB, { fehler, ort, korrelationsId }, await einstellungen.lese("betrieb.fehlerSpeichernAbSchwere"));
  }

  const offene = await zaehleOffene(env.DB);
  if (offene >= (await einstellungen.lese("betrieb.deadLetterAlarmAb"))) {
    const fehler = new AppFehler("DEAD_LETTER", "Dead-Letter-Schwelle erreicht", { kontext: { offene } });
    await alarmPruefen(env.DB, env.EMAIL, { fehler, ort, korrelationsId, fingerabdruck: await fingerabdruck(fehler.code, ort, fehler.message) });
  }
}
