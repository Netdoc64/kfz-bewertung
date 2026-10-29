import { Einstellungen } from "../einstellungen/dienst.js";
import type { Bindings } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { mitFehlerspeicher } from "../fehler/handler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { holeNach, meldeGeparkte } from "./nachholen.js";

/** Einstieg für alle Cron-Trigger. Jede Aufgabe ist idempotent. */
export async function fuehreCronAus(controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(env.DB, `cron ${controller.cron}`, async (korrelationsId) => {
    const einstellungen = new Einstellungen(env.DB, async () => {});
    const abSchwere = await einstellungen.lese("betrieb.fehlerSpeichernAbSchwere");
    try {
      await holeNach(env.DB, einstellungen, env.BEWERTUNG_QUEUE, korrelationsId);
      await meldeGeparkte(env.DB, korrelationsId, abSchwere, env.EMAIL);
    } catch (e) {
      const fehler = new AppFehler("CRON_FEHLGESCHLAGEN", undefined, { ursache: e });
      await fehlerSpeichern(env.DB, { fehler, ort: "cron:nachholen", korrelationsId }, abSchwere, env.EMAIL);
      throw fehler;
    }
  }, env.EMAIL);
}
