import { Einstellungen } from "../einstellungen/dienst.js";
import type { Bindings } from "../env.js";
import { alsAppFehler } from "../fehler/app-fehler.js";
import { mitFehlerspeicher } from "../fehler/handler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { verarbeiteBewertungsJob } from "./bewertungs-job.js";

/** Einstieg für Bewertungs-Queue und Dead-Letter-Queue (`batch.queue` unterscheidet). */
export async function verarbeiteQueue(batch: MessageBatch<unknown>, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(env.DB, `queue ${batch.queue}`, async (korrelationsId) => {
    // Dead-Letter: Ablage und Alarm sind ein eigenes Thema; bis dahin nur bestätigen.
    if (batch.queue.includes("dead-letter")) {
      batch.ackAll();
      return;
    }
    const einstellungen = new Einstellungen(env.DB, async () => {});
    for (const nachricht of batch.messages) {
      try {
        await verarbeiteBewertungsJob(env.DB, einstellungen, nachricht.body);
        nachricht.ack();
      } catch (e) {
        const fehler = alsAppFehler(e);
        await fehlerSpeichern(env.DB, { fehler, ort: `queue ${batch.queue}`, korrelationsId }, await einstellungen.lese("betrieb.fehlerSpeichernAbSchwere"), env.EMAIL);
        // Veraltet oder unbrauchbar: erneutes Zustellen ändert nichts. Alles andere wiederholt die Queue (dann Dead-Letter).
        if (fehler.code === "JOB_VERALTET" || fehler.code === "EINGABE_UNGUELTIG" || fehler.code === "NICHT_GEFUNDEN") nachricht.ack();
        else nachricht.retry();
      }
    }
  }, env.EMAIL);
}
