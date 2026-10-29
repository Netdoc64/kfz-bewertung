import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import type { AusgehendeNachricht, Kanal } from "../versand/kanal.js";

/** Bezug auf die Kundenmail, auf die geantwortet wird (RFC 5322 §3.6.4). */
export interface MailBezug {
  /** Message-ID der Kundenmail, mit spitzen Klammern. */
  messageId: string;
  /** References-Kette der Kundenmail; die Message-ID wird angehängt. */
  references?: string;
  /** Betreff der Kundenmail. */
  betreff?: string;
}

/** Protokollkonstanten: RFC 3834 (Auto-Submitted), RFC 5322 (Reply-Bezug). */
function kopfzeilen(bezug: MailBezug | undefined): Record<string, string> {
  const kopf: Record<string, string> = { "Auto-Submitted": "auto-replied" };
  if (bezug?.messageId) {
    kopf["In-Reply-To"] = bezug.messageId;
    kopf["References"] = [bezug.references?.trim(), bezug.messageId].filter(Boolean).join(" ");
  }
  return kopf;
}

/**
 * E-Mail-Kanal für den Versand-Port: sendet über das send_email-Binding.
 * Jede Mail trägt `Auto-Submitted: auto-replied`, damit Gegenstellen nicht
 * automatisch zurückantworten; mit `bezug` hängt sie am Kundenfaden.
 * Absender und Standardbetreff kommen aus den Einstellungen.
 */
export class EmailKanal implements Kanal {
  readonly name = "email";

  constructor(
    private readonly email: SendEmail,
    private readonly einstellungen: Einstellungen,
    private readonly bezug?: MailBezug,
  ) {}

  async sende(nachricht: AusgehendeNachricht): Promise<{ externeId?: string }> {
    const von = await this.einstellungen.lese("mail.absenderAdresse");
    if (!von) throw new AppFehler("VERSAND_FEHLGESCHLAGEN", "mail.absenderAdresse nicht gesetzt", { kontext: { kanal: this.name } });
    const betreff = this.bezug?.betreff ? (/^re:/i.test(this.bezug.betreff) ? this.bezug.betreff : `Re: ${this.bezug.betreff}`) : await this.einstellungen.lese("mail.antwortBetreff");
    const r = await this.email.send({ from: von, to: nachricht.an, subject: betreff, text: nachricht.text, headers: kopfzeilen(this.bezug) });
    return { externeId: r.messageId };
  }
}
