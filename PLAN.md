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
4. **Nichts geht ohne Freigabe zum Kunden.** Versand ist unumkehrbar.
5. **Ein Fehlersystem für alles.** Katalog mit Codes, Korrelations-ID über die
   ganze Kette, Ablage mit Fingerabdruck und Zähler, keine Geheimnisse/PII im Log.
6. **Geheimnisse kommen vom Business Manager**, nie von Hand.

## Stack

TypeScript durchgängig. Rust lohnt nicht: die Last ist I/O (mobile.de, D1),
nicht Rechnen; geteilte Typen mit React wiegen mehr.

| Teil | Technik |
|---|---|
| `packages/shared` | zod-Schemas, Fehlerkatalog, Einstellungs-Registry, Statusmaschine, KI-Port |
| `apps/api` | Cloudflare Worker + Hono, D1, Queues, KV (Cache), R2 (Berichte) |
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
6. Bericht speichert Eingabe, Vergleiche und den Abdruck der Einstellungen.

## Randfälle

| Bereich | Fall | Umgang |
|---|---|---|
| Eingang | Dieselbe Anfrage über mehrere Kanäle | Dublette über Kunde + FIN/Kennzeichen im Zeitfenster |
| Eingang | Pflichtangaben fehlen | Rückfrage, nie raten; nach N Versuchen/Timeout → Admin |
| Eingang | Keine Bewertungsanfrage | → `an_mensch` |
| Eingang | Autoreply/Bounce | Schleifenschutz |
| Eingang | Bots am Formular | Turnstile |
| Eingang | Prompt-Injection | Kundentext ist Daten; KI ohne wirkende Werkzeuge |
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
| Bewertung | Veraltet | `berichte.gueltigTage` |
| Bericht | Rechtliches | „Marktwerteinschätzung, kein Gutachten“ |
| Betrieb | Queue liefert mindestens einmal | Idempotente Verarbeitung |
| Betrieb | Ungültiger Einstellungswert in D1 | Standardwert nutzen + Fehler melden, nie abstürzen |
| DSGVO | Personendaten, Fahrzeugschein-Foto | Löschfristen, Auskunft, Löschung |
| Sicherheit | Admin-Zugang | Cloudflare Access (JWT geprüft) |
| Sicherheit | Webhooks | HMAC-Signatur |

## Phasen

| Phase | Inhalt | Stand |
|---|---|---|
| 0 | Monorepo, D1-Schema, Fehlersystem, Einstellungen, Statusmaschine, KI-Port | in Arbeit |
| 1 | Admin-Web-App, Formular, Mock-mobile.de, Bewertungskern, Regel-Engine, Bericht, Freigabe | offen |
| 2 | E-Mail-Eingang | offen |
| 3 | WhatsApp-Eingang über den Manager | offen |
| 4 | Echter mobile.de-Zugang | wartet auf Freischaltung |
| 5 | KI-Anschluss | offen |
| 6 | Smartphone-App | offen |
