import type { Fahrzeug } from "./fahrzeug.js";

/**
 * Optionaler KI-Anschluss. Die Bewertung braucht ihn nicht: jede Fähigkeit hat
 * einen Weg ohne KI (Formular, Rückfrage, Vorlage). Die KI legt nie einen Preis fest.
 *
 * Gibt eine Fähigkeit `null` zurück, nimmt der Aufrufer den Weg ohne KI.
 */

export type KiFaehigkeit = "freitext_auslesen" | "dokument_auslesen" | "anfrage_einordnen" | "bericht_formulieren" | "plausibilitaet";

export interface AuslesenErgebnis {
  fahrzeug: Partial<Fahrzeug>;
  /** Je Feld 0..1 — unter der Schwelle wird nachgefragt statt übernommen. */
  sicherheit: Partial<Record<keyof Fahrzeug, number>>;
}

export type Einordnung = "bewertung" | "rueckfrage_antwort" | "sonstiges" | "spam";

export interface BerichtEingabe {
  sprache: string;
  fahrzeug: Fahrzeug;
  /** Bereits fest berechnete Zahlen — die KI formuliert nur. */
  zahlen: Record<string, number>;
  begruendungen: string[];
}

export interface KiAnschluss {
  readonly name: string;
  kann(f: KiFaehigkeit): boolean;
  freitextAuslesen(text: string): Promise<AuslesenErgebnis | null>;
  dokumentAuslesen(bild: { mime: string; daten: ArrayBuffer }): Promise<AuslesenErgebnis | null>;
  anfrageEinordnen(text: string): Promise<Einordnung | null>;
  berichtFormulieren(eingabe: BerichtEingabe): Promise<string | null>;
}

/** Standard: keine KI. Alles liefert null → Weg ohne KI. */
export const KEINE_KI: KiAnschluss = {
  name: "keine",
  kann: () => false,
  freitextAuslesen: async () => null,
  dokumentAuslesen: async () => null,
  anfrageEinordnen: async () => null,
  berichtFormulieren: async () => null,
};
