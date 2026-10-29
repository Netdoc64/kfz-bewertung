import type { Bindings } from "../env.js";
import { Einstellungen } from "../einstellungen/dienst.js";
import { mitFehlerspeicher } from "../fehler/handler.js";
import { pruefeSchleifenschutz } from "./schleifenschutz.js";

/**
 * Einstieg für eingehende E-Mail. Der Schleifenschutz läuft zuerst: Autoreply,
 * Bounce, Listenpost und eigene Absender werden verworfen und nur protokolliert —
 * nie beantwortet.
 */
export async function verarbeiteEmail(nachricht: ForwardableEmailMessage, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(
    env.DB,
    "email",
    async (korrelationsId) => {
      const einst = new Einstellungen(env.DB, async () => {});
      const eigene = [
        await einst.lese("mail.absenderAdresse"),
        await einst.lese("mail.eingangsAdresse"),
        ...(await einst.lese("mail.eigeneAdressen")),
      ].filter((a) => a !== "");
      const urteil = pruefeSchleifenschutz({ kopfzeilen: nachricht.headers, umschlagAbsender: nachricht.from, eigeneAdressen: eigene });
      if (urteil.verwerfen) {
        console.warn("EMAIL_VERWORFEN", { grund: urteil.grund, detail: urteil.detail, korrelationsId });
      }
    },
    env.EMAIL,
  );
}
