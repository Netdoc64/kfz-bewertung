# Plan — KFZ-Bewertung

Kundenanfragen (WhatsApp, E-Mail, Web-Formular) werden autonom bewertet:
Fahrzeug erkennen → Vergleichsinserate von mobile.de → Marktpreis →
Ankaufspreis über Zu-/Abschlagsregeln → Bericht → **Freigabe durch den Admin**
→ weitere Abwicklung (Angebot, Gegenangebot, Besichtigung, Ankauf, Absage).

## Grundsätze

1. **Dynamic first.** Keine Zahl, kein Text, kein Schwellwert steht fest im Code.
   Alles liegt in der Einstellungs-Registry (`packages/shared/src/einstellungen.ts`)
   mit Schema, Standardwert und Beschreibung, und ist zur Laufzeit in D1 änderbar
   — mit Version, Verlauf und optimistischer Sperre.
2. **Die Bewertung braucht keine KI.** Der Kern ist deterministisch: Statistik über
   Vergleichsinserate plus Regel-Engine. Gleiche Eingabe + gleiche
   Einstellungsversion = gleiches Ergebnis.
3. **KI ist ein optionaler Anschluss** (`KiAnschluss`-Port, Standard „keine KI“).
   Vorgesehen für: Freitext auslesen, Fahrzeugschein-Foto auslesen, Anfrage
   einordnen, Berichtstext formulieren, Plausibilität prüfen. Fällt sie aus oder
   ist sie aus, greifen Formular, Rückfrage und Vorlagen.
4. **Kein Preis ohne Freigabe.** Nachrichten **ohne Preis** (Eingangsbestätigung,
   Rückfrage, Datenschutzhinweis) gehen automatisch aus Vorlagen raus. Alles,
   was einen Preis oder eine Zusage enthält, geht erst nach Admin-Freigabe.
   Versand ist unumkehrbar.
5. **Ein Fehlersystem für alles.** Katalog mit Codes, Korrelations-ID über die
   ganze Kette, Ablage mit Fingerabdruck und Zähler, keine Geheimnisse/PII im Log.
6. **Geheimnisse kommen vom Business Manager**, nie von Hand.
7. **Im Zweifel an einen Menschen.** Jede Lage, die das System nicht sicher
   entscheiden kann, endet in `an_mensch` mit Grund — nie in Raten oder Stille.

## Stack

TypeScript durchgängig. Rust lohnt nicht: die Last ist I/O (mobile.de, D1),
nicht Rechnen; geteilte Typen mit React wiegen mehr.

| Teil | Technik |
|---|---|
| `packages/shared` | zod-Schemas, Fehlerkatalog, Einstellungs-Registry, Statusmaschine, KI-Port |
| `apps/api` | Cloudflare Worker + Hono, D1, Queues, KV (Cache), R2 (Berichte), Cron-Trigger |
| `apps/web` | React + Vite (Admin-Oberfläche, Formular) — Phase 1 |
| App | Expo oder Capacitor — Phase 6 |

## Anfrage-Ablauf (Statusmaschine)

`eingegangen → unvollstaendig ⇄ eingegangen → in_bewertung → zur_freigabe →
freigegeben → angebot_versendet → verhandlung → angekauft | abgesagt`

Nebenwege: `zur_freigabe → nachbearbeiten → in_bewertung`, `zur_freigabe →
abgelehnt`, jederzeit `→ an_mensch` und `→ fehlgeschlagen`. Übergänge stehen im
Code (Invarianten), Beschriftungen in den Einstellungen.

## Preislogik

1. Vergleichsinserate suchen, stufenweise erweitern (`bewertung.suchStufen`).
2. Ausreißer per IQR entfernen (`bewertung.ausreisserIqrFaktor`), Mindestanzahl
   prüfen (`bewertung.mindestVergleiche`) → sonst Konfidenz niedrig → Admin.
3. Marktpreis = Median, korrigiert um km/Alter-Abweichung zum Zielfahrzeug.
4. Erwarteter Verkaufspreis = Marktpreis − Angebotsabschlag.
5. Ankaufspreis = Verkaufspreis − Marge − Aufbereitung ± Regeln
   (`ankauf.regeln`: Bedingung über Fahrzeugmerkmale → Prozent oder Betrag).
6. Plausibilitätsgrenzen prüfen (siehe Autonomie, A7). Verletzt → `an_mensch`.
7. Bericht speichert Eingabe, Vergleiche und den Abdruck der Einstellungen.

## Autonomie — Betrieb ohne Aufsicht

Diese Punkte machen den Unterschied zwischen „läuft, wenn jemand zuschaut“ und
„läuft allein“. Jede Zeile wird zu Einstellungen (neue Registry-Schlüssel) und Tests.

| # | Thema | Entscheidung | Neue Einstellungen |
|---|---|---|---|
| A1 | Was geht ohne Freigabe raus | Nur Nachrichten ohne Preis aus Vorlagen; alles mit Preis nach Freigabe | `antwort.automatischErlaubt` (Liste der Anlässe) |
| A2 | Not-Aus | Ein Schalter für alles: `an` = normal, `nur_verarbeiten` = bewerten, aber nichts senden, `aus` = Eingänge annehmen und parken | `ablauf.autopilot` |
| A3 | Admin erfährt von offenen Freigaben | Benachrichtigung beim Wechsel nach `zur_freigabe`, Erinnerung nach X Stunden, Eskalation nach Y Stunden | `benachrichtigung.kanal`, `benachrichtigung.erinnerungNachStunden`, `benachrichtigung.eskalationNachStunden` |
| A4 | Alarm bei Fehlern | E-Mail über Cloudflare Email Service; WhatsApp über den Manager später. Gleicher Fingerabdruck alarmiert höchstens einmal je Zeitfenster | `betrieb.alarmKanal`, `betrieb.alarmRuheMinuten` |
| A5 | Zeitgesteuerte Aufgaben | Cron-Trigger: Rückfrage-Timeout, Freigabe-Erinnerung, Berichtsablauf, DSGVO-Löschung, Fehleraufräumen, Referenzdaten-Abgleich. Jeder Lauf idempotent und mit Korrelations-ID | `betrieb.cronAufgaben` (an/aus je Aufgabe) |
| A6 | Wann entscheidet das System allein | An einen Menschen bei: Konfidenz < Schwelle, Ankaufspreis > Betrag, Rückfragen ausgeschöpft, Fahrzeugklasse ausgeschlossen (Oldtimer, Nutzfahrzeug …), KI-Einordnung „sonstiges“ | `ablauf.eskalation` (Objekt mit Schwellen) |
| A7 | Plausibilitätsgrenzen beim Preis | Summe aller Regelabschläge gedeckelt; Ankauf nie über Marktpreis; Mindestankaufspreis; Spanne Verkauf↔Ankauf in Grenzen | `ankauf.maxGesamtAbschlagProzent`, `ankauf.mindestPreisEuro`, `ankauf.maxSpanneProzent` |
| A8 | Kunde schreibt während der Bewertung | Nachricht wird an die Anfrage gehängt; läuft eine Bewertung, wird sie verworfen und mit dem neuen Stand neu gestartet (Job-Generation in der Anfrage) | — |
| A9 | Flut von einem Absender | Höchstzahl Anfragen je Absender und Tag; darüber parken und Admin informieren | `eingang.maxJeAbsenderUndTag` |
| A10 | Einstellungsänderung prüfen | Zusätzliche Plausibilitätsgrenzen je Schlüssel (Warnung, nicht nur Schema); Vorschau: letzte N Berichte mit neuem Wert neu rechnen, Unterschied zeigen, erst dann speichern | `einstellungen.vorschauAnzahl` |
| A11 | Lernen aus echten Ankäufen | Beim Abschluss den tatsächlichen Preis erfassen; Abweichung zur Schätzung je Marke/Segment auswerten | — |
| A12 | Kennzahlen | Durchlaufzeit je Status, Anteil `an_mensch` mit Grund, Konfidenzverteilung, Fehlerrate, Freigabedauer | — |
| A13 | mobile.de-Referenzdaten | Marken-/Modell-IDs regelmäßig abgleichen (Cron), Zuordnungstabelle Freitext → ID, pflegbar in der Oberfläche | `quelle.referenzAbgleichStunden` |
| A14 | Datenschutzhinweis | Erste automatische Antwort je Kontakt enthält den Hinweis (Vorlage); Löschung auf Anfrage über die Oberfläche | Vorlage `datenschutz` in `antwort.vorlagen` |

Ein Cron- oder Queue-Lauf, der scheitert, landet im Fehlersystem — nie still.
Jede automatische Nachricht wird als Ereignis an der Anfrage gespeichert
(Inhalt, Kanal, Vorlage, Einstellungsabdruck).

## Randfälle

| Bereich | Fall | Umgang |
|---|---|---|
| Eingang | Dieselbe Anfrage über mehrere Kanäle | Dublette über Kunde + FIN/Kennzeichen im Zeitfenster |
| Eingang | Pflichtangaben fehlen | Rückfrage, nie raten; nach N Versuchen/Timeout → Admin |
| Eingang | Keine Bewertungsanfrage | → `an_mensch` |
| Eingang | Autoreply/Bounce | Schleifenschutz |
| Eingang | Bots am Formular | Turnstile |
| Eingang | Prompt-Injection | Kundentext ist Daten; KI ohne wirkende Werkzeuge |
| Eingang | Mehrere Fahrzeuge in einer Nachricht | Je Fahrzeug eine Anfrage, verknüpft über den Kontakt |
| Fahrzeug | Mehrdeutiges Modell | Referenzdaten mobile.de; sonst Rückfrage |
| Fahrzeug | E-Auto/Hybrid | SoH abfragen, sonst Vorbehalt |
| Fahrzeug | Oldtimer, Import, Unfall, Tuning | Konfidenz niedrig → Admin |
| mobile.de | Kein Zugang | Mock-Adapter, gleiche Schnittstelle |
| mobile.de | Nutzungsbedingungen | Vor Livegang prüfen, **kein Scraping** |
| mobile.de | Zu wenige Treffer | Stufenweise erweitern, im Bericht vermerken |
| mobile.de | Ausreißer (1 €, Export, Leasing) | Filter + IQR |
| mobile.de | Netto/Brutto gemischt | Vereinheitlichen |
| mobile.de | 429/Timeout/Ausfall | Backoff, Dead-Letter, Status „wartet auf Quelle“ |
| mobile.de | Antwortformat ändert sich | zod-Prüfung, eigener Fehlercode |
| Bewertung | Nachvollziehbarkeit | Abdruck der Einstellungen je Bericht |
| Bewertung | Veraltet | `ablauf.berichtGueltigTage` |
| Bewertung | Regeln stapeln sich | Deckel (A7) |
| Bericht | Rechtliches | „Marktwerteinschätzung, kein Gutachten“ |
| Betrieb | Queue liefert mindestens einmal | Idempotente Verarbeitung (`verarbeitete_jobs`) |
| Betrieb | Ungültiger Einstellungswert in D1 | Standardwert nutzen + Fehler melden, nie abstürzen |
| Betrieb | Dead-Letter-Queue füllt sich | Ansicht in der Oberfläche, erneut einreihen per Knopf, Alarm ab Schwelle |
| Betrieb | Deploy während laufender Jobs | Jobs tragen Schema-Version; ältere werden weiter verarbeitet oder sauber abgewiesen |
| DSGVO | Personendaten, Fahrzeugschein-Foto | Löschfristen, Auskunft, Löschung |
| Sicherheit | Admin-Zugang | Cloudflare Access (JWT geprüft) |
| Sicherheit | Webhooks | HMAC-Signatur, Zeitstempel gegen Wiederholung |

## Phasen und Fertig-Kriterien

Eine Phase ist fertig, wenn **alle** Kriterien erfüllt sind. Durchgängig gilt
zusätzlich: `npm test` und `npm run typecheck` grün, `wrangler deploy --dry-run`
läuft, keine fachliche Zahl im Code (neue Werte stehen in der Registry), neue
Fehlerfälle haben einen Code im Katalog, PLAN.md ist nachgezogen.

### Phase 0 — Grundgerüst · **fertig**

- [x] Monorepo mit `packages/shared` und `apps/api`
- [x] Einstellungs-Registry mit Version, Verlauf, Konflikterkennung, Abdruck
- [x] Fehlerkatalog, Korrelations-ID, Fehlerspeicher mit Fingerabdruck und Schwärzung
- [x] Statusmaschine inkl. Freigabe und Abwicklung, KI-Port
- [x] Admin-Bereich hinter Cloudflare Access, Produktion als Standard-Umgebung

### Phase 1 — Durchstich Anfrage → Bericht (mit Mock-Daten)

- [ ] Autonomie-Einstellungen A1, A2, A6, A7, A9, A10 in der Registry, mit Tests
- [x] Anfrage anlegen über Formular-API und Admin; Pflichtangaben-Prüfung → `unvollstaendig`
- [x] Dublettenerkennung im Zeitfenster
- [ ] Bewertungs-Job über Queue, idempotent, mit Job-Generation (A8)
- [x] Mock-mobile.de-Adapter mit festen Beispieldaten (≥ 3 Fahrzeugsegmente)
- [x] Bewertungskern: Suchstufen, Filter, IQR, Median, km/Alter-Korrektur, Konfidenz
- [ ] Regel-Engine für `ankauf.regeln` mit allen Operatoren, Deckel aus A7
- [x] Goldene Testfälle: fester Datensatz + Einstellungen → exakt erwartete Preise
- [x] Bericht als HTML (Vorlagen aus Einstellungen), gespeichert mit Abdruck
- [x] Admin-Web-App (`apps/admin`): Liste mit Statusfilter und Seiten, Detail mit Bericht/Ereignissen/Nachrichten, Freigabe-Aktionen mit Version und Neuladen bei `VERSION_KONFLIKT`
- [ ] Admin-Web-App: Einstellungen bearbeiten mit Vorschau (A10), Fehlerliste
- [ ] Ende-zu-Ende-Test: Anfrage → `zur_freigabe` → `freigegeben` → `angebot_versendet` (Versand gemockt)
- [ ] Not-Aus (A2) im Ende-zu-Ende-Test geprüft: bei `aus` geht nichts raus

### Phase 2 — Betrieb ohne Aufsicht

- [ ] Cron-Aufgaben aus A5, jede mit Test für Idempotenz
- [ ] Benachrichtigung und Erinnerung für offene Freigaben (A3)
- [ ] Alarm mit Ruhezeit je Fingerabdruck (A4)
- [ ] Dead-Letter-Ansicht mit erneut Einreihen
- [ ] Kennzahlen-Seite (A12)
- [x] Erfassung des tatsächlichen Ankaufspreises (A11)

### Phase 3 — E-Mail-Eingang

- [ ] Cloudflare Email Routing → Worker, Anfrage aus Mail (Text + Anhänge)
- [x] Schleifenschutz: Autoreply/Bounce erkannt und verworfen (Tests mit echten Header-Beispielen)
- [ ] Antworten ohne Preis (A1) per Mail, Antworten mit Preis nur nach Freigabe
- [ ] Datenschutzhinweis in der ersten Antwort (A14)

### Phase 4 — WhatsApp-Eingang über den Manager

- [ ] Webhook vom Manager mit HMAC + Zeitstempel
- [ ] Versand über den Manager mit dessen Regeln; jede gesendete Nachricht als Ereignis gespeichert
- [ ] Bilder (Fahrzeugschein) werden gespeichert und dem Admin gezeigt
- [ ] Flutschutz je Absender (A9)

### Phase 5 — Echter mobile.de-Zugang · wartet auf Freischaltung

- [ ] Live-Adapter hinter derselben Schnittstelle wie der Mock
- [ ] Vertragstests gegen aufgezeichnete Antworten
- [ ] Cache, Backoff, Fehlercodes aus dem Katalog
- [ ] Referenzdaten-Abgleich (A13)
- [ ] Nutzungsbedingungen geprüft und im Repo vermerkt

### Phase 6 — KI-Anschluss

- [ ] Claude-Adapter für den `KiAnschluss`-Port, je Fähigkeit schaltbar
- [ ] Jede Fähigkeit hat einen Test „KI aus → gleicher Ablauf ohne KI“
- [ ] Tagesbudget greift; Kosten je Anfrage erfasst

### Phase 7 — Smartphone-App

- [ ] App gegen dieselbe API mit Geräte-Tokens
- [ ] Freigabe und Abwicklung mobil

## Braucht einen Menschen

| Was | Für | Blockiert |
|---|---|---|
| mobile.de-Search-API beantragen | Live-Daten | Phase 5 |
| GitHub-Repo anlegen | CI, PR-Überwachung | nichts, aber vor dem ersten PR |
| Cloudflare-Konto verbinden (`/mcp`), D1/Queues anlegen | Erster echter Deploy | Deploy, nicht die Entwicklung |
| Geheimnisse über den Business Manager | mobile.de, Webhook-Schlüssel, Mail | Phase 3–5 |
