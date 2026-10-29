import type { Einstellungen } from "./einstellungen/dienst.js";

export interface Bindings {
  DB: D1Database;
  UMGEBUNG: "entwicklung" | "produktion";
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

export interface Variablen {
  korrelationsId: string;
  einstellungen: Einstellungen;
  /** Kennung des angemeldeten Admins (E-Mail aus Cloudflare Access). */
  admin: string;
}

export type AppUmgebung = { Bindings: Bindings; Variables: Variablen };
