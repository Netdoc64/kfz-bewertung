import { FEHLER, SCHWERE_RANG } from "@kfz/shared";
import { Einstellungen } from "../einstellungen/dienst.js";
import type { AppFehler } from "../fehler/app-fehler.js";
import { sendeAdminMail } from "./absender.js";

export { sendeAdminMail } from "./absender.js";

export interface AlarmEingabe {
  fehler: AppFehler;
  ort: string;
  korrelationsId: string;
  fingerabdruck: string;
}

/**
 * Löst bei Bedarf einen Alarm aus. Wirft nie: ein Alarmfehler darf die Antwort
 * nicht verhindern, er wird nur ins Worker-Log geschrieben (ALARM_FEHLGESCHLAGEN).
 * Die Mail enthält nur Katalogtext, Code, Ort und IDs — keine Meldung, keinen Kontext.
 */
export async function alarmPruefen(db: D1Database, email: SendEmail, a: AlarmEingabe): Promise<void> {
  let beansprucht = false;
  try {
    const einst = new Einstellungen(db, async () => {});
    const kanal = await einst.lese("betrieb.alarmKanal");
    if (kanal === "aus") return;
    const def = FEHLER[a.fehler.code];
    if (SCHWERE_RANG[def.schwere] < SCHWERE_RANG[await einst.lese("betrieb.alarmAbSchwere")]) return;
    if (kanal !== "email") {
      console.error("ALARM_FEHLGESCHLAGEN", { grund: `Kanal ${kanal} nicht angebunden`, korrelationsId: a.korrelationsId });
      return;
    }

    // Ruhezeit atomar beanspruchen: nur eine Zeile ändert sich, wenn das Fenster abgelaufen ist.
    const minuten = await einst.lese("betrieb.alarmRuheMinuten");
    const r = await db
      .prepare(
        `INSERT INTO alarm_ruhe (fingerabdruck, zuletzt_alarmiert)
         VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (fingerabdruck) DO UPDATE SET zuletzt_alarmiert = excluded.zuletzt_alarmiert
         WHERE zuletzt_alarmiert <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2)`,
      )
      .bind(a.fingerabdruck, `-${minuten} minutes`)
      .run();
    if (!r.meta.changes) return;
    beansprucht = true;

    await sendeAdminMail(email, einst, {
      betreff: `[Alarm ${def.schwere}] ${a.fehler.code}`,
      text: [
        `${def.text}`,
        `Code: ${a.fehler.code}`,
        `Schwere: ${def.schwere}`,
        `Ort: ${a.ort}`,
        `Korrelations-ID: ${a.korrelationsId}`,
        `Fingerabdruck: ${a.fingerabdruck.slice(0, 12)}`,
      ].join("\n"),
    });
  } catch (e) {
    console.error("ALARM_FEHLGESCHLAGEN", { korrelationsId: a.korrelationsId, grund: String(e) });
    if (beansprucht) {
      // Ruhezeit zurücknehmen, damit der nächste Fehler es erneut versucht.
      await db.prepare("DELETE FROM alarm_ruhe WHERE fingerabdruck = ?1").bind(a.fingerabdruck).run().catch(() => {});
    }
  }
}
