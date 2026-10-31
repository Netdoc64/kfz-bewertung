import { z } from "zod";
import { REGEL_FELDER } from "./fahrzeug.js";

/**
 * Einstellungs-Registry — die einzige Quelle für fachliche Werte.
 *
 * Jeder Schlüssel hat ein Schema, einen Standardwert und eine Beschreibung.
 * Laufzeitwerte liegen versioniert in D1 (Tabelle `einstellungen`) und
 * überschreiben den Standardwert. Ein ungültiger gespeicherter Wert fällt auf
 * den Standard zurück und wird als Fehler gemeldet — er bringt nichts zum Absturz.
 *
 * Regeln: Schlüssel nie umbenennen, Typ nie ohne Migration ändern.
 */

export type EinstellungsGruppe =
  | "bewertung"
  | "ankauf"
  | "antwort"
  | "ablauf"
  | "quelle"
  | "ki"
  | "betrieb"
  | "eingang"
  | "benachrichtigung"
  | "bericht"
  | "mail"
  | "oberflaeche"
  | "app"
  | "push";

/** Plausibler Bereich eines Zahlenwerts. Außerhalb: Warnung, kein Schemafehler. */
export interface Plausibilitaet {
  min?: number;
  max?: number;
}

interface Definition<S extends z.ZodTypeAny> {
  schema: S;
  standard: z.infer<S>;
  gruppe: EinstellungsGruppe;
  beschreibung: string;
  plausibel?: Plausibilitaet;
}

function def<S extends z.ZodTypeAny>(
  gruppe: EinstellungsGruppe,
  schema: S,
  standard: z.infer<S>,
  beschreibung: string,
  plausibel?: Plausibilitaet,
): Definition<S> {
  return plausibel ? { schema, standard, gruppe, beschreibung, plausibel } : { schema, standard, gruppe, beschreibung };
}

// --- Teilschemas -----------------------------------------------------------

export const SuchStufeSchema = z.object({
  ezToleranzJahre: z.number().int().min(0),
  kmToleranzProzent: z.number().min(0),
  umkreisKm: z.number().int().positive().nullable(),
  leistungToleranzProzent: z.number().min(0),
});

export const RegelBedingungSchema = z.discriminatedUnion("op", [
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("gleich"), wert: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("ungleich"), wert: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("kleiner"), wert: z.number() }),
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("groesser"), wert: z.number() }),
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("zwischen"), von: z.number(), bis: z.number() }),
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("enthaelt"), wert: z.string() }),
  z.object({ feld: z.enum(REGEL_FELDER), op: z.literal("fehlt") }),
]);

export const AnkaufRegelSchema = z.object({
  id: z.string().min(1),
  bezeichnung: z.string().min(1),
  aktiv: z.boolean(),
  /** Alle Bedingungen müssen zutreffen. Leer = gilt immer. */
  bedingungen: z.array(RegelBedingungSchema),
  wirkung: z.discriminatedUnion("art", [
    z.object({ art: z.literal("prozent"), wert: z.number() }),
    z.object({ art: z.literal("betrag"), wert: z.number() }),
  ]),
  /** Grund, wie er im Bericht erscheint. */
  begruendung: z.string(),
});

export type AnkaufRegel = z.infer<typeof AnkaufRegelSchema>;
export type SuchStufe = z.infer<typeof SuchStufeSchema>;

/** Vorlagen je Sprache und Anlass. Platzhalter: {{name}}. */
export const VorlagenSchema = z.record(z.string().min(2), z.record(z.string(), z.string()));

export const AnlassSchema = z.enum(["eingang", "rueckfrage", "datenschutz"]);
/** Leer = nicht konfiguriert. */
export const MailAdresseSchema = z.union([z.literal(""), z.string().email()]);

export const EskalationSchema = z.object({
  /** Konfidenz (0–1) unter dieser Schwelle → Mensch. */
  konfidenzMin: z.number().min(0).max(1),
  /** Ankaufspreis über diesem Betrag → Mensch. */
  maxAnkaufEuro: z.number().positive(),
  /** Fahrzeugklassen, die nie automatisch bewertet werden. */
  ausgeschlosseneKlassen: z.array(z.string().min(1)),
  /** KI-Einordnung „sonstiges“ geht an einen Menschen. */
  sonstigesAnMensch: z.boolean(),
});

export const CronAufgabenSchema = z.object({
  rueckfrageTimeout: z.boolean(),
  freigabeErinnerung: z.boolean(),
  berichtsablauf: z.boolean(),
  dsgvoLoeschung: z.boolean(),
  fehlerAufraeumen: z.boolean(),
  referenzAbgleich: z.boolean(),
});

/** HTML-Berichtsvorlage je Sprache. Platzhalter in {{doppelten Klammern}}. */
export const BerichtVorlagenSchema = z.record(
  z.string().min(2),
  z.object({
    betreff: z.string().min(1),
    html: z.string().min(1),
    /** „Kein Gutachten“ — steht in jedem Bericht. */
    hinweis: z.string().min(1),
  }),
);

// --- Registry --------------------------------------------------------------

export const EINSTELLUNGEN = {
  // Bewertung
  "bewertung.mindestVergleiche": def("bewertung", z.number().int().min(1), 8, "Mindestanzahl bereinigter Vergleichsinserate für eine belastbare Bewertung."),
  "bewertung.zielVergleiche": def("bewertung", z.number().int().min(1), 40, "Ab dieser Trefferzahl wird die Suche nicht weiter erweitert."),
  "bewertung.suchStufen": def(
    "bewertung",
    z.array(SuchStufeSchema).min(1),
    [
      { ezToleranzJahre: 0, kmToleranzProzent: 15, umkreisKm: 200, leistungToleranzProzent: 5 },
      { ezToleranzJahre: 1, kmToleranzProzent: 25, umkreisKm: 500, leistungToleranzProzent: 10 },
      { ezToleranzJahre: 2, kmToleranzProzent: 40, umkreisKm: null, leistungToleranzProzent: 15 },
    ],
    "Stufen, um die die Vergleichssuche erweitert wird, wenn zu wenige Treffer kommen.",
  ),
  "bewertung.ausreisserIqrFaktor": def("bewertung", z.number().positive(), 1.5, "Faktor für die IQR-Ausreißerbereinigung der Vergleichspreise."),
  "bewertung.mindestPreisEuro": def("bewertung", z.number().nonnegative(), 500, "Inserate unter diesem Preis gelten als Platzhalter (z. B. 1 €) und werden verworfen."),
  "bewertung.ausschlussBegriffe": def(
    "bewertung",
    z.array(z.string()),
    ["export", "leasingübernahme", "motorschaden", "bastler", "unfallwagen"],
    "Inserate, deren Titel oder Beschreibung einen dieser Begriffe enthalten, werden verworfen.",
  ),
  "bewertung.angebotsAbschlagProzent": def("bewertung", z.number().min(0).max(100), 5, "Abschlag vom Angebotspreis (Inserat) zum erwarteten Verkaufspreis."),
  "bewertung.kmKorrekturProzentJe10000": def("bewertung", z.number(), 2.5, "Preiskorrektur je 10.000 km Abweichung vom Median der Vergleiche."),
  "bewertung.alterKorrekturProzentJeJahr": def("bewertung", z.number(), 8, "Preiskorrektur je Jahr Altersabweichung vom Median der Vergleiche."),
  "bewertung.konfidenzStreuungGrenzeProzent": def("bewertung", z.number().positive(), 15, "Variationskoeffizient der Vergleichspreise, ab dem die Konfidenz sinkt."),
  "bewertung.rundungEuro": def("bewertung", z.number().int().positive(), 50, "Preise im Bericht werden auf diesen Betrag gerundet."),

  // Ankauf
  "ankauf.margeProzent": def("ankauf", z.number().min(0).max(100), 12, "Händlermarge vom erwarteten Verkaufspreis."),
  "ankauf.aufbereitungPauschaleEuro": def("ankauf", z.number().nonnegative(), 400, "Pauschale für Aufbereitung je Fahrzeug."),
  "ankauf.standkostenEuroJeTag": def("ankauf", z.number().nonnegative(), 15, "Kosten je Standtag bis zum Weiterverkauf."),
  "ankauf.erwarteteStandtage": def("ankauf", z.number().int().nonnegative(), 30, "Erwartete Standtage, wenn die Vergleichsdaten keine liefern."),
  "ankauf.spanneProzent": def("ankauf", z.number().min(0).max(50), 5, "Verhandlungsspanne um den Ankaufspreis (von/bis im Angebot)."),
  "ankauf.maxGesamtAbschlagProzent": def(
    "ankauf",
    z.number().min(0).max(100),
    30,
    "Deckel für die Summe aller Regelabschläge in Prozent des Verkaufspreises.",
    { max: 50 },
  ),
  "ankauf.mindestPreisEuro": def("ankauf", z.number().nonnegative(), 300, "Kein Ankaufsangebot unter diesem Preis; darunter geht die Anfrage an einen Menschen.", { max: 5000 }),
  "ankauf.maxSpanneProzent": def(
    "ankauf",
    z.number().min(0).max(100),
    25,
    "Größte zulässige Spanne zwischen erwartetem Verkaufspreis und Ankaufspreis in Prozent.",
    { max: 40 },
  ),
  "ankauf.segmentGrenzenEuro": def(
    "ankauf",
    z.array(z.number().positive()).max(20),
    [5000, 15000, 30000],
    "Obergrenzen der Preissegmente (aufsteigend, in Euro, nach geschätztem Ankaufspreis) für die Auswertung der Abweichung zwischen Schätzung und tatsächlichem Ankauf.",
  ),
  "ankauf.auswertungMindestAnzahl": def(
    "ankauf",
    z.number().int().positive(),
    5,
    "Ab so vielen Ankäufen je Marke und Segment gilt die Abweichung in der Auswertung als belastbar.",
  ),
  "ankauf.regeln": def(
    "ankauf",
    z.array(AnkaufRegelSchema),
    [
      {
        id: "scheckheft",
        bezeichnung: "Scheckheftgepflegt",
        aktiv: true,
        bedingungen: [{ feld: "scheckheft", op: "gleich", wert: true }],
        wirkung: { art: "prozent", wert: 2 },
        begruendung: "Lückenlose Wartungshistorie",
      },
      {
        id: "hu-faellig",
        bezeichnung: "HU bald fällig",
        aktiv: true,
        bedingungen: [{ feld: "huRestMonate", op: "kleiner", wert: 6 }],
        wirkung: { art: "betrag", wert: -250 },
        begruendung: "Hauptuntersuchung in weniger als 6 Monaten fällig",
      },
      {
        id: "repariert",
        bezeichnung: "Reparierter Vorschaden",
        aktiv: true,
        bedingungen: [{ feld: "zustand", op: "gleich", wert: "repariert" }],
        wirkung: { art: "prozent", wert: -10 },
        begruendung: "Reparierter Unfallschaden",
      },
      {
        id: "viele-vorbesitzer",
        bezeichnung: "Viele Vorbesitzer",
        aktiv: true,
        bedingungen: [{ feld: "vorbesitzer", op: "groesser", wert: 3 }],
        wirkung: { art: "prozent", wert: -3 },
        begruendung: "Mehr als drei Vorbesitzer",
      },
      {
        id: "akku-schwach",
        bezeichnung: "Akku unter 80 % SoH",
        aktiv: true,
        bedingungen: [{ feld: "akkuSohProzent", op: "kleiner", wert: 80 }],
        wirkung: { art: "prozent", wert: -12 },
        begruendung: "Eingeschränkte Akku-Gesundheit",
      },
    ],
    "Zu- und Abschläge auf den Ankaufspreis. Prozent wirkt auf den Verkaufspreis, Betrag direkt.",
  ),

  // Antworten an Kunden
  "antwort.standardSprache": def("antwort", z.string().min(2), "de", "Sprache, wenn die Kundensprache nicht erkannt wird."),
  "antwort.vorlagen": def(
    "antwort",
    VorlagenSchema,
    {
      de: {
        eingang: "Hallo {{name}}, danke für Ihre Anfrage zum {{fahrzeug}}. Wir melden uns mit einer Einschätzung.",
        rueckfrage: "Hallo {{name}}, für die Bewertung fehlt uns noch: {{fehlend}}.",
        angebot: "Hallo {{name}}, für Ihren {{fahrzeug}} können wir {{ankaufVon}} bis {{ankaufBis}} anbieten. Das Angebot gilt bis {{gueltigBis}}.",
        absage: "Hallo {{name}}, leider können wir Ihnen für den {{fahrzeug}} derzeit kein Angebot machen.",
        hinweis: "Marktwerteinschätzung auf Basis vergleichbarer Inserate, kein Gutachten.",
        datenschutz:
          "Hinweis zum Datenschutz: Wir verarbeiten Ihre Angaben ausschließlich zur Bewertung Ihres Fahrzeugs. Auf Anfrage löschen wir Ihre Daten jederzeit.",
      },
    },
    "Antwortvorlagen je Sprache und Anlass. Platzhalter in {{doppelten Klammern}}.",
  ),
  "antwort.feldBeschriftungen": def(
    "antwort",
    z.record(z.string(), z.record(z.string(), z.string())),
    {
      de: {
        erstzulassung: "Erstzulassung (Monat und Jahr)",
        kilometer: "Kilometerstand",
        kraftstoff: "Kraftstoffart",
        getriebe: "Getriebe",
        leistungKw: "Leistung in kW",
        zustand: "Zustand des Fahrzeugs",
      },
    },
    "Kundentexte für Fahrzeugangaben je Sprache, eingesetzt als {{fehlend}} in Rückfragen. Fehlt ein Eintrag, steht der Feldname."
  ),
  "antwort.pflichtangaben": def(
    "antwort",
    z.array(z.enum(["erstzulassung", "kilometer", "kraftstoff", "getriebe", "leistungKw", "zustand"])),
    ["erstzulassung", "kilometer", "kraftstoff"],
    "Angaben, ohne die keine Bewertung startet; fehlen sie, wird nachgefragt.",
  ),

  "antwort.automatischErlaubt": def(
    "antwort",
    z.array(AnlassSchema),
    ["eingang", "rueckfrage", "datenschutz"],
    "Anlässe ohne Preis, für die Nachrichten ohne Admin-Freigabe aus Vorlagen rausgehen. Alles mit Preis braucht Freigabe.",
  ),

  // Ablauf
  "ablauf.autopilot": def(
    "ablauf",
    z.enum(["an", "nur_verarbeiten", "aus"]),
    "an",
    "Not-Aus: an = normal, nur_verarbeiten = bewerten, aber nichts senden, aus = Eingänge annehmen und parken.",
  ),
  "ablauf.eskalation": def(
    "ablauf",
    EskalationSchema,
    { konfidenzMin: 0.5, maxAnkaufEuro: 30000, ausgeschlosseneKlassen: ["oldtimer", "nutzfahrzeug"], sonstigesAnMensch: true },
    "Wann das System nicht allein entscheidet: Konfidenz unter Schwelle, Ankaufspreis über Betrag, ausgeschlossene Fahrzeugklasse, KI-Einordnung „sonstiges“.",
  ),
  "ablauf.freigabePflicht": def("ablauf", z.literal(true), true, "Jede Bewertung braucht die Freigabe eines Admins. Bewusst nicht abschaltbar."),
  "ablauf.maxRueckfragen": def("ablauf", z.number().int().min(0), 2, "Höchstzahl automatischer Rückfragen, danach geht die Anfrage an einen Menschen."),
  "ablauf.rueckfrageTimeoutStunden": def("ablauf", z.number().positive(), 48, "Ohne Antwort nach dieser Zeit geht die Anfrage an einen Menschen."),
  "ablauf.nachholenNachMinuten": def(
    "ablauf",
    z.number().int().min(1),
    5,
    "Eine Anfrage im Status „eingegangen“ wird vom Cron erst nach dieser Zeit (ohne Änderung) neu eingereiht, damit laufende Jobs nicht doppelt starten.",
    { max: 1440 },
  ),
  "ablauf.nachholenMaxJeLauf": def("ablauf", z.number().int().min(1), 50, "Höchstzahl Anfragen, die ein Cron-Lauf nachholt.", { max: 1000 }),
  "ablauf.dublettenFensterTage": def("ablauf", z.number().int().positive(), 14, "Zeitfenster, in dem gleiche Kunde+Fahrzeug als Dublette gilt."),
  "ablauf.berichtGueltigTage": def("ablauf", z.number().int().positive(), 7, "So lange gilt ein Bericht, danach muss neu bewertet werden."),
  "ablauf.listeSeitenGroesse": def("ablauf", z.number().int().positive().max(200), 25, "Anzahl Anfragen je Seite in der Admin-Liste.", { max: 200 }),
  "ablauf.kennzahlenZeitraumTage": def("ablauf", z.number().int().positive().max(3650), 30, "Standardzeitraum der Kennzahlen, wenn die Anfrage keinen Zeitraum nennt.", { max: 3650 }),
  "ablauf.kennzahlenKonfidenzGrenzen": def(
    "ablauf",
    z.array(z.number().gt(0).lt(1)).min(1).max(10).refine((a) => a.every((x, i) => i === 0 || x > a[i - 1]!), "Grenzen müssen aufsteigend sein."),
    [0.5, 0.7, 0.85],
    "Klassengrenzen (aufsteigend, 0–1) für die Konfidenzverteilung der Berichte in den Kennzahlen.",
  ),
  "ablauf.statusBeschriftungen": def(
    "ablauf",
    z.record(z.string(), z.string()),
    {
      eingegangen: "Eingegangen",
      unvollstaendig: "Wartet auf Angaben",
      in_bewertung: "In Bewertung",
      zur_freigabe: "Wartet auf Freigabe",
      nachbearbeiten: "Nachbearbeiten",
      freigegeben: "Freigegeben",
      angebot_versendet: "Angebot versendet",
      verhandlung: "In Verhandlung",
      besichtigung: "Besichtigung geplant",
      angekauft: "Angekauft",
      abgesagt: "Abgesagt",
      abgelehnt: "Abgelehnt",
      an_mensch: "Beim Menschen",
      fehlgeschlagen: "Fehlgeschlagen",
    },
    "Anzeigenamen der Status in der Oberfläche.",
  ),

  "oberflaeche.beschriftungen": def(
    "oberflaeche",
    z.record(z.string(), z.string()),
    {
      titel: "Anfragen",
      alle: "Alle",
      filter: "Status",
      leer: "Keine Anfragen.",
      laedt: "Lädt …",
      zurueck: "Zurück zur Liste",
      vor: "Weiter",
      zurueckSeite: "Zurück",
      seite: "Seite",
      von: "von",
      kunde: "Kunde",
      fahrzeug: "Fahrzeug",
      status: "Status",
      geaendert: "Geändert",
      bericht: "Bericht",
      keinBericht: "Noch kein Bericht.",
      ereignisse: "Verlauf",
      nachrichten: "Nachrichten an den Kunden",
      kundenNachrichten: "Nachrichten vom Kunden",
      notiz: "Notiz (optional)",
      aktionen: "Aktionen",
      keineAktionen: "Keine Aktion möglich.",
      konflikt: "Die Anfrage wurde zwischenzeitlich geändert und wurde neu geladen.",
      fehler: "Fehler",
      erneut: "Erneut versuchen",
      "aktion.freigeben": "Freigeben",
      "aktion.ablehnen": "Ablehnen",
      "aktion.nachbearbeiten": "Nachbearbeiten",
      "aktion.angebot_senden": "Angebot senden",
      "aktion.verhandeln": "Verhandlung starten",
      "aktion.gegenangebot_senden": "Gegenangebot senden",
      "aktion.besichtigung_planen": "Besichtigung planen",
      "aktion.ankauf_abschliessen": "Ankauf abschließen",
      "aktion.absagen": "Absagen",
      "aktion.uebernehmen": "Selbst übernehmen",
      navAnfragen: "Anfragen",
      navEinstellungen: "Einstellungen",
      navFehler: "Fehler",
      einstellungenTitel: "Einstellungen",
      fehlerTitel: "Fehlerliste",
      bearbeiten: "Bearbeiten",
      speichern: "Speichern",
      trotzdemSpeichern: "Trotzdem speichern",
      zuruecksetzen: "Auf Standard zurücksetzen",
      abbrechen: "Abbrechen",
      wert: "Wert (JSON)",
      standardwert: "Standardwert",
      gespeichert: "Gespeichert.",
      jsonUngueltig: "Der Wert ist kein gültiges JSON.",
      plausibilitaet: "Ungewöhnlicher Wert — bitte prüfen:",
      quittieren: "Quittieren",
      keineFehler: "Keine offenen Fehler.",
      fehlerCode: "Code",
      fehlerSchwere: "Schwere",
      fehlerOrt: "Ort",
      fehlerAnzahl: "Anzahl",
      fehlerZuletzt: "Zuletzt",
      gruppe: "Gruppe",
      vorschauZeigen: "Vorschau und speichern",
      speichernNachVorschau: "Speichern",
      vorschauTitel: "Vorschau: letzte Berichte mit dem neuen Wert",
      vorschauVon: "von",
      vorschauGeaendert: "Berichten würden sich ändern.",
      vorschauAnfrage: "Anfrage",
      vorschauVorher: "Ankaufspreis bisher",
      vorschauNachher: "Ankaufspreis neu",
      vorschauDifferenz: "Unterschied",
      vorschauMensch: "An Mensch (bisher → neu)",
      vorschauHinweis: "Gerechnet mit den im Bericht gespeicherten Vergleichen, nichts wurde gespeichert. Erst ein weiterer Klick speichert.",
      beschreibung: "Beschreibung",
      navDeadLetter: "Dead-Letter",
      navKennzahlen: "Kennzahlen",
      deadLetterTitel: "Dead-Letter: fehlgeschlagene Jobs",
      keineDeadLetter: "Keine offenen Einträge.",
      deadLetterSeit: "Seit",
      deadLetterQueue: "Queue",
      deadLetterVersuche: "Versuche",
      deadLetterKorrelation: "Korrelation",
      erneutEinreihen: "Erneut einreihen",
      bereitsEingereiht: "Der Eintrag war schon erneut eingereiht.",
      ankaufspreis: "Tatsächlicher Ankaufspreis (€)",
      kennzahlenTitel: "Kennzahlen",
      zeitraumVon: "Von",
      zeitraumBis: "Bis",
      kennzahlAnfragen: "Anfragen im Zeitraum",
      kennzahlDurchlauf: "Durchlaufzeit je Status",
      kennzahlOffen: "Noch in diesem Status",
      kennzahlAnzahl: "Anzahl",
      kennzahlMittel: "Mittel",
      kennzahlMedian: "Median",
      kennzahlMax: "Maximum",
      einheitStunden: "Std.",
      kennzahlAnMensch: "An Mensch",
      kennzahlMitGrund: "davon mit Grund",
      kennzahlKonfidenz: "Konfidenz",
      kennzahlFehlerrate: "Fehlerrate der Bewertung",
      kennzahlFreigabedauer: "Freigabedauer",
      kennzahlKi: "KI-Nutzung",
      kennzahlKiFaehigkeit: "Fähigkeit",
      kennzahlKiTokenEin: "Token ein",
      kennzahlKiTokenAus: "Token aus",
      kennzahlKiKosten: "Kosten (EUR)",
      kennzahlKiKostenJeAnfrage: "Kosten je Anfrage",
      kennzahlKiAufrufe: "Aufrufe",
      kennzahlKiLeer: "Keine KI-Nutzung im Zeitraum.",
      abweichungTitel: "Abweichung Schätzung zu tatsächlichem Ankauf",
      abweichungAnkaeufe: "Ankäufe",
      abweichungOhneSchaetzung: "ohne Schätzung",
      abweichungMarke: "Marke",
      abweichungSegment: "Segment",
      abweichungEuro: "Abweichung (Mittel)",
      abweichungProzent: "Abweichung in %",
      abweichungUnbelastbar: "zu wenige Ankäufe",
      abweichungLeer: "Noch keine Ankäufe erfasst.",
    },
    "Beschriftungen der Admin-Oberfläche (Anfragenliste, Detail, Einstellungen, Fehlerliste).",
  ),

  // Datenquelle
  "quelle.mobilede.modus": def("quelle", z.enum(["mock", "live"]), "mock", "mock = Beispieldaten, live = echte mobile.de-Search-API."),
  "quelle.cacheMinuten": def("quelle", z.number().int().nonnegative(), 360, "Gleiche Suchanfragen werden so lange aus dem Cache bedient."),
  "quelle.zeitlimitMs": def("quelle", z.number().int().positive(), 10000, "Zeitlimit je Anfrage an die Datenquelle."),
  "quelle.referenzAbgleichStunden": def("quelle", z.number().int().positive(), 24, "Abstand des Abgleichs der mobile.de-Marken-/Modell-IDs."),
  "quelle.maxVersuche": def("quelle", z.number().int().min(1), 4, "Versuche je Bewertungsjob, bevor er in die Dead-Letter-Queue geht."),

  // KI
  "ki.aktiv": def("ki", z.boolean(), false, "Schaltet den optionalen KI-Anschluss ein. Die Bewertung läuft auch ohne."),
  "ki.faehigkeiten": def(
    "ki",
    z.array(z.enum(["freitext_auslesen", "dokument_auslesen", "anfrage_einordnen", "bericht_formulieren", "plausibilitaet"])),
    [],
    "Welche Fähigkeiten des KI-Anschlusses genutzt werden.",
  ),
  "ki.tagesbudgetEuro": def("ki", z.number().nonnegative(), 5, "Tagesobergrenze für KI-Kosten; darüber wird ohne KI weitergearbeitet."),
  "ki.modell": def("ki", z.string().min(1), "claude-sonnet-5-5", "Modell-ID, die der KI-Anschluss anfragt."),
  "ki.aufwand": def("ki", z.enum(["niedrig", "mittel", "hoch"]), "niedrig", "Denkaufwand je KI-Anfrage; höher kostet mehr und dauert länger."),
  "ki.maxAusgabeToken": def("ki", z.number().int().positive(), 1024, "Obergrenze der Ausgabe-Token je KI-Anfrage.", { min: 64, max: 8192 }),
  "ki.zeitlimitMs": def("ki", z.number().int().positive(), 20000, "Zeitlimit je KI-Anfrage; danach wird ohne KI weitergearbeitet.", { min: 1000, max: 60000 }),
  "ki.mindestSicherheit": def(
    "ki",
    z.number().min(0).max(1),
    0.8,
    "Mindestsicherheit (0 bis 1) je ausgelesenem Feld; darunter bleibt das Feld offen und geht an einen Menschen.",
    { min: 0.5, max: 1 },
  ),
  "ki.preiseJeMillionToken": def(
    "ki",
    z.object({ eingabeEuro: z.number().nonnegative(), ausgabeEuro: z.number().nonnegative() }),
    { eingabeEuro: 3, ausgabeEuro: 15 },
    "Preis in Euro je Million Token, Grundlage der Kostenrechnung gegen das Tagesbudget. Bei Preisänderung des Anbieters anpassen.",
  ),

  // Betrieb
  "betrieb.fehlerSpeichernAbSchwere": def("betrieb", z.enum(["info", "warnung", "fehler", "kritisch"]), "warnung", "Ab dieser Schwere landet ein Fehler im Fehlerspeicher."),
  "betrieb.alarmAbSchwere":def("betrieb", z.enum(["info", "warnung", "fehler", "kritisch"]), "kritisch", "Ab dieser Schwere wird ein Alarm ausgelöst."),
  "betrieb.alarmKanal": def("betrieb", z.enum(["email", "whatsapp", "aus"]), "email", "Kanal für Alarme bei Fehlern ab `betrieb.alarmAbSchwere`."),
  "betrieb.alarmRuheMinuten": def(
    "betrieb",
    z.number().int().nonnegative(),
    60,
    "Gleicher Fehlerfingerabdruck alarmiert höchstens einmal in diesem Zeitfenster.",
    { max: 1440 },
  ),
  "betrieb.cronAufgaben": def(
    "betrieb",
    CronAufgabenSchema,
    { rueckfrageTimeout: true, freigabeErinnerung: true, berichtsablauf: true, dsgvoLoeschung: true, fehlerAufraeumen: true, referenzAbgleich: true },
    "Zeitgesteuerte Aufgaben einzeln an/aus.",
  ),
  "betrieb.deadLetterAlarmAb": def("betrieb", z.number().int().min(1), 1, "Ab so vielen Einträgen in der Dead-Letter-Queue wird alarmiert.", { max: 100 }),
  "einstellungen.vorschauAnzahl": def(
    "betrieb",
    z.number().int().min(0),
    10,
    "Wie viele der letzten Berichte eine Einstellungsänderung zur Vorschau neu rechnen.",
    { max: 100 },
  ),
  "betrieb.fehlerAufbewahrungTage": def("betrieb", z.number().int().positive(), 90, "Fehlereinträge werden nach dieser Zeit gelöscht."),
  "betrieb.personendatenAufbewahrungTage": def("betrieb", z.number().int().positive(), 365, "Kundendaten abgeschlossener Anfragen werden danach gelöscht (DSGVO)."),

  // Eingang
  "eingang.maxJeAbsenderUndTag": def(
    "eingang",
    z.number().int().min(1),
    5,
    "Höchstzahl Anfragen je Absender und Tag; darüber wird geparkt und der Admin informiert.",
    { max: 50 },
  ),

  // Benachrichtigung der Admins
  "benachrichtigung.kanal": def("benachrichtigung", z.enum(["email", "whatsapp", "aus"]), "email", "Kanal, über den Admins von offenen Freigaben erfahren."),
  "benachrichtigung.erinnerungNachStunden": def("benachrichtigung", z.number().positive(), 4, "Erinnerung, wenn eine Freigabe so lange offen ist.", { max: 72 }),
  "benachrichtigung.eskalationNachStunden": def("benachrichtigung", z.number().positive(), 24, "Eskalation, wenn eine Freigabe so lange offen ist.", { max: 168 }),

  "benachrichtigung.texte": def(
    "benachrichtigung",
    z.record(z.string(), z.object({ betreff: z.string().min(1), text: z.string().min(1) })),
    {
      neu: { betreff: "Neue Freigabe wartet: {{anfrage}}", text: "Anfrage {{anfrage}} ({{fahrzeug}}) wartet auf Freigabe." },
      erinnerung: {
        betreff: "Erinnerung: Freigabe offen seit {{stunden}} h ({{anfrage}})",
        text: "Anfrage {{anfrage}} ({{fahrzeug}}) wartet seit {{stunden}} Stunden auf Freigabe.",
      },
      eskalation: {
        betreff: "Eskalation: Freigabe offen seit {{stunden}} h ({{anfrage}})",
        text: "Anfrage {{anfrage}} ({{fahrzeug}}) wartet seit {{stunden}} Stunden auf Freigabe und braucht jetzt eine Entscheidung.",
      },
    },
    "Mailtexte an den Admin je Stufe (neu, erinnerung, eskalation). Platzhalter: {{anfrage}}, {{fahrzeug}}, {{stunden}}.",
  ),

  // Smartphone-App
  "app.tokenLaufzeitTage": def("app", z.number().int().positive(), 90, "Gültigkeit eines Geräte-Tokens; danach muss das Gerät neu gekoppelt werden.", { min: 1, max: 365 }),
  "app.kopplungscodeGueltigMinuten": def("app", z.number().int().positive(), 10, "Gültigkeit eines Kopplungscodes für ein neues Gerät.", { min: 1, max: 60 }),

  // Push
  "push.aktiv": def("push", z.boolean(), false, "Schaltet Push-Nachrichten an gekoppelte Geräte ein."),
  "push.texte": def(
    "push",
    z.record(z.string(), z.object({ titel: z.string().min(1), text: z.string().min(1) })),
    {
      neu: { titel: "Neue Freigabe", text: "Anfrage {{anfrage}} ({{fahrzeug}}) wartet auf Freigabe." },
      erinnerung: { titel: "Erinnerung: Freigabe offen", text: "Anfrage {{anfrage}} ({{fahrzeug}}) wartet seit {{stunden}} Stunden." },
      eskalation: { titel: "Eskalation: Freigabe offen", text: "Anfrage {{anfrage}} ({{fahrzeug}}) braucht seit {{stunden}} Stunden eine Entscheidung." },
    },
    "Push-Texte je Stufe (neu, erinnerung, eskalation). Platzhalter: {{anfrage}}, {{fahrzeug}}, {{stunden}}.",
  ),

  // Bericht
  "bericht.vorlagen": def(
    "bericht",
    BerichtVorlagenSchema,
    {
      de: {
        betreff: "Ihre Fahrzeugbewertung: {{fahrzeug}}",
        html:
          "<h1>Fahrzeugbewertung</h1><p>{{fahrzeug}}</p>" +
          "<p>Ankaufspreis: {{ankaufVon}} bis {{ankaufBis}}</p>" +
          "<p>Marktpreis: {{marktpreis}}, Verkaufspreis: {{verkaufspreis}}</p>" +
          "<p>Suchstufe {{suchstufeNr}} von {{suchstufeAnzahl}}: Erstzulassung ±{{suchstufeEzJahre}} Jahre, " +
          "Kilometer ±{{suchstufeKmProzent}} %, Umkreis {{suchstufeUmkreisKm}} km</p>" +
          "<h2>Vergleichsfahrzeuge ({{anzahlVergleiche}})</h2>" +
          "<table><tr><th>Preis</th><th>Kilometer</th><th>Erstzulassung</th></tr>{{vergleichsZeilen}}</table>" +
          "<h2>Angewendete Regeln</h2><ul>{{regelnListe}}</ul>" +
          "<p>Gültig bis {{gueltigBis}}.</p><p><small>{{hinweis}}</small></p>",
        hinweis: "Marktwerteinschätzung auf Basis vergleichbarer Inserate, kein Gutachten.",
      },
    },
    "HTML-Berichtsvorlage je Sprache, inklusive Hinweis „kein Gutachten“.",
  ),

  // Mail (Adressen, keine Geheimnisse; leer = nicht konfiguriert)
  "versand.manager.zeitlimitMs": def("betrieb", z.number().int().positive(), 10_000, "Zeitlimit je Aufruf an den Manager (Millisekunden).", { min: 1_000, max: 30_000 }),
  "versand.manager.wiederholungen": def("betrieb", z.number().int().min(0), 2, "Weitere Versuche nach einem wiederholbaren Managerfehler (mit derselben Korrelation).", { max: 5 }),
  "versand.manager.abstandMs": def("betrieb", z.number().int().min(0), 2_000, "Wartezeit zwischen zwei Versuchen (Millisekunden); ein Retry-After des Managers hat Vorrang, gedeckelt durch versand.manager.abstandMaxMs.", { max: 30_000 }),
  "versand.manager.abstandMaxMs": def("betrieb", z.number().int().min(0), 10_000, "Längste Wartezeit zwischen zwei Versuchen, auch wenn der Manager mehr verlangt (Millisekunden).", { max: 60_000 }),
  "mail.absenderAdresse": def("mail", MailAdresseSchema, "", "Absenderadresse für ausgehende Mails."),
  "mail.antwortBetreff": def("mail", z.string().min(1), "Ihre Anfrage", "Betreff automatischer Antworten, wenn die Kundenmail keinen Betreff hatte (sonst „Re: …“)."),
  "mail.eingangsAdresse": def("mail", MailAdresseSchema, "", "Adresse, an die Kunden Anfragen mailen (E-Mail-Eingang)."),
  "mail.eigeneAdressen": def("mail", z.array(z.string().email()), [], "Weitere eigene Absenderadressen; Mails von hier (und von mail.absenderAdresse) werden als Schleife verworfen."),
  "mail.adminEmpfaenger": def("mail", z.array(z.string().email()), [], "Empfänger für Freigabe-Benachrichtigungen und Alarme."),
  "mail.maxGroesseBytes": def("mail", z.number().int().positive(), 15_000_000, "Größere eingehende Mails werden als ungültig abgewiesen.", { max: 25_000_000 }),
  "mail.anhangMaxAnzahl": def("mail", z.number().int().min(0), 5, "Höchstzahl gespeicherter Anhänge je Mail; weitere werden verworfen und protokolliert.", { max: 20 }),
  "mail.anhangMaxBytes": def("mail", z.number().int().positive(), 8_000_000, "Größere einzelne Anhänge werden nicht gespeichert.", { max: 20_000_000 }),
  "mail.anhangTypen": def("mail", z.array(z.string().min(3)), ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"], "Erlaubte Medientypen für Anhänge (Fahrzeugschein-Fotos)."),
  "mail.marken": def(
    "mail",
    z.array(z.string().min(2)),
    ["Alfa Romeo", "Audi", "BMW", "Citroën", "Dacia", "Fiat", "Ford", "Honda", "Hyundai", "Jaguar", "Jeep", "Kia", "Land Rover", "Mazda", "Mercedes", "Mini", "Mitsubishi", "Nissan", "Opel", "Peugeot", "Porsche", "Renault", "Seat", "Skoda", "Smart", "Subaru", "Suzuki", "Tesla", "Toyota", "Volvo", "VW", "Volkswagen"],
    "Marken, die beim regelbasierten Auslesen einer Kundenmail erkannt werden. Unbekannte Marken lösen eine Rückfrage aus.",
  ),
  "mail.modellStoppwoerter": def(
    "mail",
    z.array(z.string().min(1)),
    ["aus", "mit", "von", "bj", "baujahr", "ez", "km", "und", "in", "hat", "ist", "der", "die", "das", "im", "zum", "zu", "für"],
    "Wörter, die direkt hinter einer Marke nie ein Modell sind (Auslesen ohne KI).",
  ),
} as const;

export type EinstellungsSchluessel = keyof typeof EINSTELLUNGEN;
export type EinstellungsWert<K extends EinstellungsSchluessel> = z.infer<(typeof EINSTELLUNGEN)[K]["schema"]>;

export function istEinstellungsSchluessel(s: string): s is EinstellungsSchluessel {
  return Object.prototype.hasOwnProperty.call(EINSTELLUNGEN, s);
}

export const EINSTELLUNGS_SCHLUESSEL = Object.keys(EINSTELLUNGEN) as EinstellungsSchluessel[];

/**
 * Plausibilitätswarnungen für einen Wert (A10). Greift nur bei Zahlen und nur,
 * wenn der Schlüssel Grenzen hat. Eine Warnung verhindert das Speichern nicht.
 */
export function plausibilitaetsWarnungen(schluessel: EinstellungsSchluessel, wert: unknown): string[] {
  const grenzen = (EINSTELLUNGEN[schluessel] as { plausibel?: Plausibilitaet }).plausibel;
  if (!grenzen || typeof wert !== "number") return [];
  const warnungen: string[] = [];
  if (grenzen.min !== undefined && wert < grenzen.min) warnungen.push(`${schluessel}: ${wert} liegt unter dem üblichen Bereich (ab ${grenzen.min}).`);
  if (grenzen.max !== undefined && wert > grenzen.max) warnungen.push(`${schluessel}: ${wert} liegt über dem üblichen Bereich (bis ${grenzen.max}).`);
  return warnungen;
}
