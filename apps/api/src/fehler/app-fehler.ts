import { FEHLER, type FehlerCode } from "@kfz/shared";

export interface FehlerOptionen {
  /** Für den Aufrufer bestimmt (z. B. Feldfehler). Wird in der Antwort gezeigt. */
  details?: unknown;
  /** Nur intern, landet geschwärzt im Fehlerspeicher. */
  kontext?: Record<string, unknown>;
  ursache?: unknown;
}

export class AppFehler extends Error {
  readonly code: FehlerCode;
  readonly details: unknown;
  readonly kontext: Record<string, unknown> | undefined;

  constructor(code: FehlerCode, nachricht?: string, optionen: FehlerOptionen = {}) {
    super(nachricht ?? FEHLER[code].text, { cause: optionen.ursache });
    this.name = "AppFehler";
    this.code = code;
    this.details = optionen.details;
    this.kontext = optionen.kontext;
  }

  get definition() {
    return FEHLER[this.code];
  }
}

/** Macht aus allem, was geworfen wird, einen AppFehler. */
export function alsAppFehler(e: unknown): AppFehler {
  if (e instanceof AppFehler) return e;
  const nachricht = e instanceof Error ? e.message : String(e);
  if (/D1_|SQLITE/i.test(nachricht)) return new AppFehler("DATENBANK", nachricht, { ursache: e });
  return new AppFehler("INTERN", nachricht, { ursache: e });
}
