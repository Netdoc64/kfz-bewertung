import type { Bindings } from "../env.js";
import { Einstellungen } from "../einstellungen/dienst.js";
import type { KiAbhaengigkeiten } from "../ki/index.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { pruefeRatenlimit } from "../ratelimit/index.js";
import { mitFehlerspeicher } from "../fehler/handler.js";
import { verarbeiteEingang } from "./eingang.js";
import { pruefeSchleifenschutz } from "./schleifenschutz.js";

/**
 * Einstieg für eingehende E-Mail. Der Schleifenschutz läuft zuerst: Autoreply,
 * Bounce, Listenpost und eigene Absender werden verworfen und nur protokolliert —
 * nie beantwortet. Danach liest `verarbeiteEingang` die Anfrage aus der Mail.
 */
export async function verarbeiteEmail(nachricht: ForwardableEmailMessage, env: Bindings, _ctx: ExecutionContext, ki: KiAbhaengigkeiten = {}): Promise<void> {
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
        return;
      }
      // Ratenbegrenzung je Absender: bei Überschreitung wird verworfen und protokolliert, nie geantwortet.
      try {
        await pruefeRatenlimit(env.DB, einst, "email", nachricht.from);
      } catch (e) {
        if (!(e instanceof AppFehler) || e.code !== "RATE_LIMIT_UEBERSCHRITTEN") throw e;
        await fehlerSpeichern(env.DB, { fehler: e, ort: "email:ratenlimit", korrelationsId }, "info", env.EMAIL);
        return;
      }
      await verarbeiteEingang(nachricht, env, einst, korrelationsId, ki);
    },
    env.EMAIL,
  );
}
