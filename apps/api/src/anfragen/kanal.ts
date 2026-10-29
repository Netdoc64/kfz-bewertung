import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import type { Kanal } from "../versand/kanal.js";

/** Kanal für ausgehende Mail über das send_email-Binding. Betreff = erste Zeile des Textes. */
export class EmailKanal implements Kanal {
  readonly name = "email";

  constructor(
    private readonly email: SendEmail,
    private readonly von: string,
  ) {}

  async sende(n: { an: string; text: string; korrelation: string }): Promise<{ externeId?: string }> {
    await this.email.send({ from: this.von, to: n.an, subject: n.text.split("\n")[0]!.slice(0, 78), text: n.text });
    return {};
  }
}

/** Kanal passend zum Kontakt, oder null, wenn dafür (noch) kein Kanal angebunden ist. */
export async function kanalFuerKontakt(email: SendEmail, einstellungen: Einstellungen, kontakt: string): Promise<Kanal | null> {
  if (!kontakt.includes("@")) return null;
  const von = await einstellungen.lese("mail.absenderAdresse");
  if (von === "") throw new AppFehler("VERSAND_FEHLGESCHLAGEN", "mail.absenderAdresse nicht gesetzt");
  return new EmailKanal(email, von);
}
