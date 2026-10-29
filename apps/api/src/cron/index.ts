import type { Bindings } from "../env.js";
import { mitFehlerspeicher } from "../fehler/handler.js";

/** Einstieg für alle Cron-Trigger. Platzhalter: tut nichts. */
export async function fuehreCronAus(controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(env.DB, `cron ${controller.cron}`, async () => {}, env.EMAIL);
}
