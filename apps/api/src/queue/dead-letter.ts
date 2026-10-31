import { uebergang } from "@kfz/shared";
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

/**
 * Schließt die hängende Anfrage ab: steht sie noch in „in_bewertung“ und ist der Job nicht
 * überholt (gleiche Generation), geht sie per `fehlschlag` auf „fehlgeschlagen“. Der erneut
 * eingereihte Job startet daraus wieder (`bewertung_starten`).
 */
async function anfrageAbschliessen(db: D1Database, anfrageId: string, generation: number, korrelation: string | null): Promise<void> {
  const nach = uebergang("in_bewertung", "fehlschlag", "system");
  if (!nach) return;
  const [upd] = await db.batch([
    db
      .prepare(
        "UPDATE anfragen SET status = ?1, version = version + 1, geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2 AND status = 'in_bewertung' AND generation = ?3",
      )
      .bind(nach, anfrageId, generation),
    db
      .prepare(
        "INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, notiz, korrelation) SELECT ?1, 'fehlschlag', 'in_bewertung', ?2, 'system', 'DEAD_LETTER', ?3 WHERE changes() > 0",
      )
      .bind(anfrageId, nach, korrelation),
  ]);
  void upd;
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
    if (typeof anfrageId === "string" && typeof generation === "number") {
      await anfrageAbschliessen(env.DB, anfrageId, generation, typeof korrelation === "string" ? korrelation : null);
    }
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
