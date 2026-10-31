/**
 * Zentraler Fehlerkatalog. Jeder Fehler im System hat genau einen Code von hier.
 * Neuer Fehlerfall → neuer Eintrag, nie ein freier Fehlertext in einer Route.
 */

export type Schwere = "info" | "warnung" | "fehler" | "kritisch";

export const SCHWERE_RANG: Record<Schwere, number> = {
  info: 0,
  warnung: 1,
  fehler: 2,
  kritisch: 3,
};

export interface FehlerDefinition {
  /** HTTP-Status, wenn der Fehler eine Anfrage beendet. */
  status: number;
  schwere: Schwere;
  /** Darf ein Job bei diesem Fehler automatisch wiederholt werden? */
  wiederholbar: boolean;
  /** Text für Admin-Oberfläche und API-Antwort. Enthält nie Interna. */
  text: string;
}

export const FEHLER = {
  // Eingabe und Zugriff
  EINGABE_UNGUELTIG: { status: 400, schwere: "info", wiederholbar: false, text: "Die Angaben sind unvollständig oder ungültig." },
  NICHT_ANGEMELDET: { status: 401, schwere: "warnung", wiederholbar: false, text: "Anmeldung erforderlich." },
  KEINE_BERECHTIGUNG: { status: 403, schwere: "warnung", wiederholbar: false, text: "Keine Berechtigung für diese Aktion." },
  NICHT_GEFUNDEN: { status: 404, schwere: "info", wiederholbar: false, text: "Nicht gefunden." },
  SIGNATUR_UNGUELTIG: { status: 401, schwere: "warnung", wiederholbar: false, text: "Signatur der Anfrage ist ungültig." },

  // Ablauf
  STATUSWECHSEL_UNZULAESSIG: { status: 409, schwere: "warnung", wiederholbar: false, text: "Dieser Schritt ist im aktuellen Status nicht möglich." },
  VERSION_KONFLIKT: { status: 409, schwere: "info", wiederholbar: false, text: "Der Eintrag wurde zwischenzeitlich geändert. Bitte neu laden." },
  ANKAUFSPREIS_UNGUELTIG: { status: 422, schwere: "info", wiederholbar: false, text: "Für den Abschluss fehlt der tatsächliche Ankaufspreis oder er ist ungültig." },
  DUBLETTE: { status: 409, schwere: "info", wiederholbar: false, text: "Diese Anfrage liegt bereits vor." },

  // Einstellungen
  EINSTELLUNG_UNBEKANNT: { status: 404, schwere: "warnung", wiederholbar: false, text: "Diese Einstellung gibt es nicht." },
  EINSTELLUNG_UNGUELTIG: { status: 422, schwere: "fehler", wiederholbar: false, text: "Der Einstellungswert passt nicht zum erwarteten Format." },

  // Datenquelle (mobile.de)
  QUELLE_NICHT_ERREICHBAR: { status: 502, schwere: "fehler", wiederholbar: true, text: "Die Datenquelle ist gerade nicht erreichbar." },
  QUELLE_LIMIT: { status: 503, schwere: "warnung", wiederholbar: true, text: "Die Datenquelle bremst gerade. Es wird später erneut versucht." },
  QUELLE_ANTWORT_UNGUELTIG: { status: 502, schwere: "kritisch", wiederholbar: false, text: "Die Datenquelle hat ein unerwartetes Format geliefert." },
  QUELLE_ZUGANG: { status: 502, schwere: "kritisch", wiederholbar: false, text: "Der Zugang zur Datenquelle wurde abgewiesen." },

  // Bewertung
  ZU_WENIG_VERGLEICHE: { status: 422, schwere: "warnung", wiederholbar: false, text: "Zu wenige Vergleichsfahrzeuge für eine belastbare Bewertung." },
  FAHRZEUG_UNKLAR: { status: 422, schwere: "info", wiederholbar: false, text: "Das Fahrzeug ist nicht eindeutig bestimmbar." },

  // KI (optionaler Anschluss)
  KI_NICHT_AKTIV: { status: 503, schwere: "info", wiederholbar: false, text: "Der KI-Anschluss ist nicht aktiv." },
  KI_FEHLER: { status: 502, schwere: "warnung", wiederholbar: true, text: "Der KI-Anschluss hat nicht geantwortet." },
  KI_ABGELEHNT: { status: 422, schwere: "warnung", wiederholbar: false, text: "Der KI-Anschluss hat diese Anfrage abgelehnt; sie wird von einem Menschen geprüft." },
  KI_ZEITUEBERSCHREITUNG: { status: 504, schwere: "warnung", wiederholbar: true, text: "Der KI-Anschluss hat zu lange gebraucht." },
  KI_ANTWORT_UNGUELTIG: { status: 502, schwere: "warnung", wiederholbar: false, text: "Die Antwort des KI-Anschlusses hatte ein unerwartetes Format." },
  KI_BUDGET_ERSCHOEPFT: { status: 429, schwere: "info", wiederholbar: false, text: "Das KI-Tagesbudget ist aufgebraucht; es wird ohne KI weitergearbeitet." },

  // App und Push
  KOPPLUNGSCODE_UNGUELTIG: { status: 401, schwere: "warnung", wiederholbar: false, text: "Der Kopplungscode ist ungültig oder abgelaufen." },
  GERAET_WIDERRUFEN: { status: 401, schwere: "warnung", wiederholbar: false, text: "Dieses Gerät ist nicht mehr gekoppelt. Bitte neu koppeln." },
  PUSH_FEHLGESCHLAGEN: { status: 502, schwere: "warnung", wiederholbar: true, text: "Die Push-Nachricht konnte nicht zugestellt werden." },

  // Autonomie und Betrieb
  AUTOPILOT_GESPERRT: { status: 423, schwere: "info", wiederholbar: false, text: "Der automatische Betrieb ist gerade angehalten." },
  FREIGABE_FEHLT: { status: 403, schwere: "warnung", wiederholbar: false, text: "Für diese Nachricht fehlt die Freigabe eines Admins." },
  VERSAND_FEHLGESCHLAGEN: { status: 502, schwere: "fehler", wiederholbar: true, text: "Die Nachricht konnte nicht versendet werden." },
  VERSAND_VORLAGE_FEHLT: { status: 500, schwere: "fehler", wiederholbar: false, text: "Für diese Nachricht fehlt eine Vorlage oder ein Wert für einen Platzhalter." },
  RATE_LIMIT_UEBERSCHRITTEN: { status: 429, schwere: "info", wiederholbar: true, text: "Zu viele Anfragen in kurzer Zeit. Bitte etwas warten und erneut versuchen." },
  ZU_VIELE_ANFRAGEN: { status: 429, schwere: "warnung", wiederholbar: false, text: "Zu viele Anfragen von diesem Absender. Bitte später erneut versuchen." },
  PLAUSIBILITAET_VERLETZT: { status: 422, schwere: "warnung", wiederholbar: false, text: "Das Ergebnis liegt außerhalb der zulässigen Grenzen und wird von einem Menschen geprüft." },
  JOB_VERALTET: { status: 409, schwere: "info", wiederholbar: false, text: "Die Anfrage hat sich geändert; die Bewertung wird neu gestartet." },
  BERICHT_FEHLT: { status: 404, schwere: "warnung", wiederholbar: false, text: "Zu dieser Anfrage gibt es keinen Bericht." },
  BERICHT_ABGELAUFEN: { status: 409, schwere: "info", wiederholbar: false, text: "Der Bericht ist abgelaufen. Bitte neu bewerten lassen." },
  BERICHT_VORLAGE_FEHLT: { status: 500, schwere: "fehler", wiederholbar: false, text: "Für den Bericht ist keine Vorlage hinterlegt." },
  MAIL_UNGUELTIG: { status: 422, schwere: "warnung", wiederholbar: false, text: "Die E-Mail konnte nicht gelesen werden." },
  MAIL_SCHLEIFE: { status: 422, schwere: "warnung", wiederholbar: false, text: "Die E-Mail ist eine automatische Nachricht und wird nicht beantwortet." },
  CRON_FEHLGESCHLAGEN: { status: 500, schwere: "fehler", wiederholbar: true, text: "Eine zeitgesteuerte Aufgabe ist fehlgeschlagen." },
  ALARM_FEHLGESCHLAGEN: { status: 502, schwere: "kritisch", wiederholbar: true, text: "Der Alarm konnte nicht zugestellt werden." },
  DEAD_LETTER: { status: 500, schwere: "kritisch", wiederholbar: false, text: "Ein Auftrag ist endgültig fehlgeschlagen und wartet auf einen Menschen." },

  // DSGVO
  DSGVO_OFFENE_ANFRAGE: { status: 409, schwere: "warnung", wiederholbar: false, text: "Zu dieser Person gibt es noch offene Anfragen; die Löschung ist laut Einstellung gesperrt." },
  DSGVO_LOESCHUNG_FEHLGESCHLAGEN: { status: 500, schwere: "fehler", wiederholbar: true, text: "Die Personendaten konnten nicht vollständig gelöscht werden. Bitte erneut versuchen." },

  // Technik
  DATENBANK: { status: 500, schwere: "kritisch", wiederholbar: true, text: "Interner Speicherfehler." },
  INTERN: { status: 500, schwere: "kritisch", wiederholbar: false, text: "Interner Fehler." },
} as const satisfies Record<string, FehlerDefinition>;

export type FehlerCode = keyof typeof FEHLER;

export function istFehlerCode(code: string): code is FehlerCode {
  return Object.prototype.hasOwnProperty.call(FEHLER, code);
}

/** Einheitliches Fehlerformat jeder API-Antwort. */
export interface FehlerAntwort {
  fehler: {
    code: FehlerCode;
    text: string;
    korrelationsId: string;
    wiederholbar: boolean;
    /** Nur nutzerseitig unbedenkliche Details, z. B. Feldfehler. */
    details?: unknown;
  };
}
