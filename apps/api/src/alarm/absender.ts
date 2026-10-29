import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";

export interface AdminMail {
  betreff: string;
  text: string;
}

/**
 * Schickt eine Mail an `mail.adminEmpfaenger` über das send_email-Binding.
 * Gemeinsamer Absender für Alarme (A4) und Freigabe-Benachrichtigungen (A3).
 * Wirft ALARM_FEHLGESCHLAGEN, wenn Absender/Empfänger fehlen oder der Versand scheitert.
 */
export async function sendeAdminMail(email: SendEmail, einstellungen: Einstellungen, mail: AdminMail): Promise<void> {
  const von = await einstellungen.lese("mail.absenderAdresse");
  const an = await einstellungen.lese("mail.adminEmpfaenger");
  if (!von || an.length === 0) {
    throw new AppFehler("ALARM_FEHLGESCHLAGEN", "mail.absenderAdresse oder mail.adminEmpfaenger nicht gesetzt");
  }
  try {
    await email.send({ from: von, to: an, subject: mail.betreff, text: mail.text });
  } catch (e) {
    throw new AppFehler("ALARM_FEHLGESCHLAGEN", "Admin-Mail nicht versendet", { ursache: e });
  }
}
