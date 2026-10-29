import type { Bindings } from "../env.js";
import { mitFehlerspeicher } from "../fehler/handler.js";

/** Einstieg für eingehende E-Mail. Platzhalter: tut nichts. */
export async function verarbeiteEmail(_nachricht: ForwardableEmailMessage, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(env.DB, "email", async () => {}, env.EMAIL);
}
