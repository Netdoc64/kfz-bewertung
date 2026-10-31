import type { Einstellungen } from "./einstellungen/dienst.js";

export interface Bindings {
  DB: D1Database;
  /** Bewertungsjobs (Producer). */
  BEWERTUNG_QUEUE: Queue<unknown>;
  /** Ausgehende E-Mail. */
  EMAIL: SendEmail;
  /** Berichte und Anhänge. */
  BERICHTE: R2Bucket;
  UMGEBUNG: "entwicklung" | "produktion";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Basis-URL des Business Managers (Standort-Variable); fehlt sie, gibt es keinen WhatsApp-Versand. */
  MANAGER_VERSAND_URL?: string;
  /** HMAC-Geheimnis kfz-bewertung → Manager; verteilt der Business Manager. */
  MANAGER_VERSAND_HMAC_SCHLUESSEL?: string;
  /** API-Schlüssel des KI-Anbieters; fehlt er, läuft alles ohne KI. */
  KI_API_SCHLUESSEL?: string;
  /** Firebase-Projekt für Push (Standort-Variable); fehlt es, gibt es keinen Push. */
  PUSH_FCM_PROJEKT?: string;
  /** Dienstkonto-Schlüssel für FCM; verteilt der Business Manager. */
  PUSH_FCM_DIENSTKONTO?: string;
}

export interface Variablen {
  korrelationsId: string;
  einstellungen: Einstellungen;
  /** Kennung des angemeldeten Admins (E-Mail aus Cloudflare Access). */
  admin: string;
}

export type AppUmgebung = { Bindings: Bindings; Variables: Variablen };

/** Zugang zum Manager aus den Bindings; Teile können fehlen (dann kein WhatsApp-Kanal). */
export function managerZugang(env: Bindings): { url?: string; hmacSchluessel?: string } {
  return {
    ...(env.MANAGER_VERSAND_URL ? { url: env.MANAGER_VERSAND_URL } : {}),
    ...(env.MANAGER_VERSAND_HMAC_SCHLUESSEL ? { hmacSchluessel: env.MANAGER_VERSAND_HMAC_SCHLUESSEL } : {}),
  };
}
