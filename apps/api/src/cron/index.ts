import { Einstellungen } from "../einstellungen/dienst.js";
import type { Bindings } from "../env.js";
import { AppFehler, alsAppFehler } from "../fehler/app-fehler.js";
import { mitFehlerspeicher } from "../fehler/handler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { pushFuer } from "../push/index.js";
import { berichtsablauf, dsgvoLoeschung, fehlerAufraeumen, freigabeErinnerung, referenzAbgleich, rueckfrageTimeout, type AufgabenErgebnis } from "./aufgaben.js";
import { holeNach, meldeGeparkte } from "./nachholen.js";

/** Schalter in `betrieb.cronAufgaben`, die diese Datei bedient. */
type Aufgabe = "rueckfrageTimeout" | "freigabeErinnerung" | "berichtsablauf" | "dsgvoLoeschung" | "fehlerAufraeumen" | "referenzAbgleich";

/**
 * Führt eine Aufgabe aus und protokolliert den Lauf in `cron_laeufe`. Ein Fehler wird im
 * Fehlerspeicher als CRON_FEHLGESCHLAGEN festgehalten und zurückgegeben, damit die übrigen
 * Aufgaben trotzdem laufen — der Aufrufer wirft am Ende.
 */
async function laufe(
  env: Bindings,
  aufgabe: Aufgabe,
  an: boolean,
  korrelation: string,
  abSchwere: Parameters<typeof fehlerSpeichern>[2],
  tun: () => Promise<AufgabenErgebnis>,
): Promise<AppFehler | null> {
  const protokoll = (status: string, bearbeitet: number, notiz?: string, code?: string) =>
    env.DB.prepare(
      "INSERT INTO cron_laeufe (aufgabe, korrelation, status, bearbeitet, notiz, fehler_code, ende) VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
      .bind(aufgabe, korrelation, status, bearbeitet, notiz ?? null, code ?? null)
      .run();
  if (!an) {
    await protokoll("aus", 0, "per betrieb.cronAufgaben abgeschaltet");
    return null;
  }
  try {
    const e = await tun();
    await protokoll(e.uebersprungen ? "uebersprungen" : "ok", e.bearbeitet, e.notiz);
    return null;
  } catch (ursache) {
    const fehler = new AppFehler("CRON_FEHLGESCHLAGEN", undefined, { ursache, kontext: { aufgabe, ursachenCode: alsAppFehler(ursache).code } });
    await fehlerSpeichern(env.DB, { fehler, ort: `cron:${aufgabe}`, korrelationsId: korrelation }, abSchwere, env.EMAIL);
    await protokoll("fehler", 0, undefined, fehler.code).catch(() => {});
    return fehler;
  }
}

/** Einstieg für alle Cron-Trigger. Jede Aufgabe ist idempotent. */
export async function fuehreCronAus(controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  await mitFehlerspeicher(env.DB, `cron ${controller.cron}`, async (korrelationsId) => {
    const einstellungen = new Einstellungen(env.DB, async () => {});
    const abSchwere = await einstellungen.lese("betrieb.fehlerSpeichernAbSchwere");
    const schalter = await einstellungen.lese("betrieb.cronAufgaben");
    const jetzt = controller.scheduledTime > 0 ? controller.scheduledTime : Date.now();
    const fehler: AppFehler[] = [];
    const sammle = (f: AppFehler | null) => void (f && fehler.push(f));

    try {
      await holeNach(env.DB, einstellungen, env.BEWERTUNG_QUEUE, korrelationsId);
      await meldeGeparkte(env.DB, korrelationsId, abSchwere, env.EMAIL);
    } catch (e) {
      const f = new AppFehler("CRON_FEHLGESCHLAGEN", undefined, { ursache: e });
      await fehlerSpeichern(env.DB, { fehler: f, ort: "cron:nachholen", korrelationsId }, abSchwere, env.EMAIL);
      fehler.push(f);
    }

    sammle(await laufe(env, "rueckfrageTimeout", schalter.rueckfrageTimeout, korrelationsId, abSchwere, () => rueckfrageTimeout(env.DB, einstellungen, korrelationsId, jetzt)));
    sammle(await laufe(env, "freigabeErinnerung", schalter.freigabeErinnerung, korrelationsId, abSchwere, () => freigabeErinnerung(env.DB, einstellungen, env.EMAIL, jetzt, pushFuer(env))));
    sammle(await laufe(env, "berichtsablauf", schalter.berichtsablauf, korrelationsId, abSchwere, () => berichtsablauf(env.DB, korrelationsId, jetzt)));
    sammle(await laufe(env, "dsgvoLoeschung", schalter.dsgvoLoeschung, korrelationsId, abSchwere, () => dsgvoLoeschung(env.DB, einstellungen, jetzt)));
    sammle(await laufe(env, "fehlerAufraeumen", schalter.fehlerAufraeumen, korrelationsId, abSchwere, () => fehlerAufraeumen(env.DB, einstellungen, jetzt)));
    sammle(await laufe(env, "referenzAbgleich", schalter.referenzAbgleich, korrelationsId, abSchwere, () => referenzAbgleich(einstellungen)));

    if (fehler.length > 0) throw fehler[0]!;
  }, env.EMAIL);
}

export { berichtsablauf, dsgvoLoeschung, fehlerAufraeumen, freigabeErinnerung, referenzAbgleich, rueckfrageTimeout };
