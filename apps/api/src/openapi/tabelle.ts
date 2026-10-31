import type { z } from "zod";
import { AktionSchema, AnhaengenSchema, AnlegenSchema, ListeSchema } from "../anfragen/index.js";
import { KoppelnSchema, PushTokenSchema } from "../routen/app.js";
import { KontaktSchema, LoeschSchema } from "../routen/dsgvo.js";
import { SetzenSchema, VorschauSchema } from "../routen/einstellungen.js";
import { FilterSchema as FehlerFilterSchema } from "../routen/fehler.js";
import { MailFreigabeSchema } from "../routen/geparkt.js";
import { FilterSchema as KennzahlenFilterSchema } from "../routen/kennzahlen.js";

export interface Endpunkt {
  methode: "get" | "post" | "put";
  /** Pfad in Hono-Schreibweise (`:id`); die Spezifikation macht daraus `{id}`. */
  pfad: string;
  tag: string;
  zusammenfassung: string;
  /** Wer ruft auf: offen (Formular), Cloudflare Access (Admin) oder gekoppeltes Gerät (App). */
  zugang: "oeffentlich" | "admin" | "geraet";
  query?: z.ZodType;
  body?: z.ZodType;
}

const A = "/api/admin";

/** Alle Routen aus `index.ts`. Der Test `openapi.test.ts` meldet jede, die hier fehlt oder überzählig ist. */
export const ENDPUNKTE: readonly Endpunkt[] = [
  { methode: "get", pfad: "/api/gesundheit", tag: "System", zusammenfassung: "Gesundheitsprüfung inklusive Datenbank", zugang: "oeffentlich" },
  { methode: "post", pfad: "/api/anfragen", tag: "Formular", zusammenfassung: "Anfrage aus dem Webformular anlegen", zugang: "oeffentlich", body: AnlegenSchema },

  { methode: "get", pfad: `${A}/einstellungen`, tag: "Einstellungen", zusammenfassung: "Alle Einstellungen mit Wert und Version", zugang: "admin" },
  { methode: "get", pfad: `${A}/einstellungen/:schluessel`, tag: "Einstellungen", zusammenfassung: "Eine Einstellung lesen", zugang: "admin" },
  { methode: "get", pfad: `${A}/einstellungen/:schluessel/verlauf`, tag: "Einstellungen", zusammenfassung: "Änderungsverlauf einer Einstellung", zugang: "admin" },
  { methode: "post", pfad: `${A}/einstellungen/:schluessel/vorschau`, tag: "Einstellungen", zusammenfassung: "Wirkung eines Wertes auf die letzten Berichte rechnen", zugang: "admin", body: VorschauSchema },
  { methode: "put", pfad: `${A}/einstellungen/:schluessel`, tag: "Einstellungen", zusammenfassung: "Einstellung setzen (null = Standardwert)", zugang: "admin", body: SetzenSchema },

  { methode: "get", pfad: `${A}/fehler`, tag: "Fehler", zusammenfassung: "Fehlerspeicher auflisten", zugang: "admin", query: FehlerFilterSchema },
  { methode: "post", pfad: `${A}/fehler/:id/quittieren`, tag: "Fehler", zusammenfassung: "Fehler quittieren", zugang: "admin" },

  { methode: "get", pfad: `${A}/anfragen`, tag: "Anfragen", zusammenfassung: "Anfragen auflisten", zugang: "admin", query: ListeSchema },
  { methode: "get", pfad: `${A}/anfragen/auswertung/ankaeufe`, tag: "Anfragen", zusammenfassung: "Abweichung Schätzung gegen Ankaufspreis", zugang: "admin" },
  { methode: "get", pfad: `${A}/anfragen/:id`, tag: "Anfragen", zusammenfassung: "Anfrage mit Bericht und Verlauf", zugang: "admin" },
  { methode: "post", pfad: `${A}/anfragen/:id/aktion`, tag: "Anfragen", zusammenfassung: "Aktion auf eine Anfrage (Freigabe, Absage, Abschluss …)", zugang: "admin", body: AktionSchema },
  { methode: "post", pfad: `${A}/anfragen`, tag: "Anfragen", zusammenfassung: "Anfrage manuell anlegen", zugang: "admin", body: AnlegenSchema },
  { methode: "post", pfad: `${A}/anfragen/:id/nachrichten`, tag: "Anfragen", zusammenfassung: "Nachricht des Kunden an eine Anfrage hängen", zugang: "admin", body: AnhaengenSchema },

  { methode: "get", pfad: `${A}/geparkt`, tag: "Geparkt", zusammenfassung: "Geparkte Eingänge auflisten", zugang: "admin" },
  { methode: "get", pfad: `${A}/geparkt/:id`, tag: "Geparkt", zusammenfassung: "Geparkten Eingang lesen", zugang: "admin" },
  { methode: "get", pfad: `${A}/geparkt/:id/anhaenge/:anhangId`, tag: "Geparkt", zusammenfassung: "Anhang eines geparkten Eingangs laden", zugang: "admin" },
  { methode: "post", pfad: `${A}/geparkt/:id/pruefen`, tag: "Geparkt", zusammenfassung: "Eingang als in Prüfung markieren", zugang: "admin" },
  { methode: "post", pfad: `${A}/geparkt/:id/freigeben`, tag: "Geparkt", zusammenfassung: "Eingang freigeben und Anfrage anlegen", zugang: "admin", body: MailFreigabeSchema },
  { methode: "post", pfad: `${A}/geparkt/:id/verwerfen`, tag: "Geparkt", zusammenfassung: "Eingang verwerfen", zugang: "admin" },

  { methode: "get", pfad: `${A}/dead-letter`, tag: "Dead Letter", zusammenfassung: "Gescheiterte Jobs auflisten", zugang: "admin" },
  { methode: "get", pfad: `${A}/dead-letter/:id`, tag: "Dead Letter", zusammenfassung: "Gescheiterten Job lesen", zugang: "admin" },
  { methode: "post", pfad: `${A}/dead-letter/:id/erneut`, tag: "Dead Letter", zusammenfassung: "Gescheiterten Job erneut einreihen", zugang: "admin" },

  { methode: "post", pfad: `${A}/dsgvo/auskunft`, tag: "DSGVO", zusammenfassung: "Auskunft zu einer Person (Art. 15)", zugang: "admin", body: KontaktSchema },
  { methode: "post", pfad: `${A}/dsgvo/loeschung`, tag: "DSGVO", zusammenfassung: "Personendaten löschen (Art. 17)", zugang: "admin", body: LoeschSchema },

  { methode: "get", pfad: `${A}/kennzahlen`, tag: "Kennzahlen", zusammenfassung: "Kennzahlen für einen Zeitraum", zugang: "admin", query: KennzahlenFilterSchema },

  { methode: "get", pfad: `${A}/geraete`, tag: "Geräte", zusammenfassung: "Gekoppelte Geräte auflisten", zugang: "admin" },
  { methode: "post", pfad: `${A}/geraete/kopplungscode`, tag: "Geräte", zusammenfassung: "Kopplungscode erzeugen", zugang: "admin" },
  { methode: "post", pfad: `${A}/geraete/:id/widerrufen`, tag: "Geräte", zusammenfassung: "Gerät widerrufen", zugang: "admin" },

  { methode: "post", pfad: "/api/app/koppeln", tag: "App", zusammenfassung: "Gerät mit Kopplungscode koppeln", zugang: "oeffentlich", body: KoppelnSchema },
  { methode: "post", pfad: "/api/app/push-token", tag: "App", zusammenfassung: "Push-Token des Geräts speichern", zugang: "geraet", body: PushTokenSchema },
  { methode: "get", pfad: "/api/app/beschriftungen", tag: "App", zusammenfassung: "Beschriftungen für die App", zugang: "geraet" },
  { methode: "get", pfad: "/api/app", tag: "App", zusammenfassung: "Anfragen auflisten", zugang: "geraet", query: ListeSchema },
  { methode: "get", pfad: "/api/app/:id", tag: "App", zusammenfassung: "Anfrage lesen", zugang: "geraet" },
  { methode: "post", pfad: "/api/app/:id/aktion", tag: "App", zusammenfassung: "Aktion auf eine Anfrage", zugang: "geraet", body: AktionSchema },
];
