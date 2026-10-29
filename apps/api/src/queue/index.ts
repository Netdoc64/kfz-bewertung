import type { Bindings } from "../env.js";
import { mitFehlerspeicher } from "../fehler/handler.js";

/** Einstieg für Bewertungs-Queue und Dead-Letter-Queue (`batch.queue` unterscheidet). Platzhalter: bestätigt alles. */
export async function verarbeiteQueue(batch: MessageBatch<unknown>, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(env.DB, `queue ${batch.queue}`, async () => {
    batch.ackAll();
  });
}
