# Betriebshandbuch kfz-bewertung

Für wen: wer den Worker deployt, überwacht und im Störfall eingreift. Alles hier ist am Code
belegt; wo ein Weg im Code **fehlt**, steht es als **Lücke** da — nichts davon ist erfunden.

Fachliche Werte (Schwellen, Fristen, Texte) stehen nie im Code, sondern in der Registry
[`packages/shared/src/einstellungen.ts`](../packages/shared/src/einstellungen.ts) und werden im
Admin-Bereich oder über `PUT /api/admin/einstellungen/:schluessel` geändert. Dieses Handbuch
nennt die Schlüssel, nicht ihre Werte.

## 1. Deploy

Konfiguration: [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc).

| Umgebung | Aufruf | Variablen | Ressourcen |
|---|---|---|---|
| **Produktion** (oberste Ebene, ohne `--env`) | `npm run deploy -w @kfz/api` (= `wrangler deploy`) | `UMGEBUNG=produktion`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | D1 `kfz-bewertung`, Queues `bewertung` / `bewertung-dead-letter`, R2 `kfz-bewertung-berichte`, Cron `*/15 * * * *`, `send_email` `EMAIL` |
| **entwicklung** (`env.entwicklung`) | `npm run dev -w @kfz/api` (= `wrangler dev --env entwicklung`) | `UMGEBUNG=entwicklung`, Access-Prüfung übersprungen | D1 `kfz-bewertung-dev`, Queues `bewertung-dev` / `bewertung-dead-letter-dev`, R2 `kfz-bewertung-berichte-dev` |

Wichtig:

- Ein `wrangler deploy` ohne `--env` ist Produktion. Dort ist die Cloudflare-Access-Prüfung an;
  **ohne `ACCESS_TEAM_DOMAIN` und `ACCESS_AUD` verweigert der Admin-Bereich** (`/api/admin/*`).
  Beide sind in `wrangler.jsonc` leer und müssen vor dem ersten echten Deploy gesetzt werden
  (keine Geheimnisse, aber standortabhängig).
- `database_id` steht in beiden Ebenen auf der Platzhalter-UUID `00000000-…`. Nach
  `wrangler d1 create kfz-bewertung` (bzw. `kfz-bewertung-dev`) die echte ID eintragen.
- Queues und R2-Bucket müssen vor dem ersten Deploy existieren (`wrangler queues create …`,
  `wrangler r2 bucket create …`). Die Dead-Letter-Queue hat einen eigenen Consumer
  (`max_retries: 0`), damit Nachrichten in D1 sichtbar werden.
- **Vor jedem Deploy** (siehe CLAUDE.md „Fertig heißt“): `npm test`, `npm run typecheck` und
  `cd apps/api; npx wrangler deploy --dry-run --outdir ..\..\.wrangler\dry` müssen grün sein. Die
  CI führt dasselbe aus ([`ci.yml`](../.github/workflows/ci.yml)).
- Reihenfolge bei Schemaänderung: **erst Migration auf Remote, dann Deploy** (siehe 2).
- Gesundheitsprüfung nach dem Deploy: `GET /api/gesundheit` → `{ ok: true, umgebung }`. Die Route
  fragt auch D1 ab; kommt keine 200, ist die Datenbank nicht erreichbar.

### Geheimnisse und Standort-Variablen

Nur **Namen**, aus [`apps/api/.dev.vars.example`](../apps/api/.dev.vars.example). Die Werte
verteilt der Business Manager (Reiter „Schlüssel“); sie werden nie von Hand in Dateien, Chat oder
dieses Handbuch geschrieben.

| Name | Zweck | Fehlt er |
|---|---|---|
| `MOBILEDE_BENUTZER`, `MOBILEDE_PASSWORT` | mobile.de-Anbindung (vorgesehen) | Mock-Modus (`quelle.mobilede.modus`) |
| `WEBHOOK_HMAC_SCHLUESSEL` | Webhook-Signatur (vorgesehen) | — |
| `KI_API_SCHLUESSEL` | KI-Anschluss (nur Auslesen/Formulieren, nie der Preis) | alles läuft ohne KI |
| `MANAGER_VERSAND_URL`, `MANAGER_VERSAND_HMAC_SCHLUESSEL` | WhatsApp-Versand über den Manager ([manager-versand.md](manager-versand.md)) | kein WhatsApp-Kanal |
| `PUSH_FCM_PROJEKT`, `PUSH_FCM_DIENSTKONTO` | Push an die App | kein Push |

Bindings und Variablen im Code: [`apps/api/src/env.ts`](../apps/api/src/env.ts).

## 2. Migrationen

Dateien: [`apps/api/migrations/`](../apps/api/migrations) (`0001` bis `0012`, D1-Format, fortlaufend).

| Ziel | Befehl (PowerShell, im Ordner `apps\api`) |
|---|---|
| Lokal (Entwicklungs-DB) | `npm run db:migrate:lokal` (= `wrangler d1 migrations apply kfz-bewertung-dev --local --env entwicklung`) |
| Remote Entwicklung | `npx wrangler d1 migrations apply kfz-bewertung-dev --remote --env entwicklung` |
| Remote Produktion | `npx wrangler d1 migrations apply kfz-bewertung --remote` |
| Stand ansehen | `npx wrangler d1 migrations list kfz-bewertung --remote` |

Regeln:

- Migrationen nur **anhängen**, bestehende Dateien nie ändern. Wer in der Registry einen Schlüssel
  umbenennt oder den Typ ändert, braucht eine Migration, die gespeicherte Werte in `einstellungen`
  mitzieht (CLAUDE.md).
- Es gibt zwei Dateien mit Präfix `0007` (`0007_cron.sql`, `0007_geparkt_pruefung.sql`). Wrangler
  wendet sie nach Dateiname sortiert an; beide stehen im selben Stand. Neue Migrationen beginnen mit
  `0013`.
- **Lücke:** Es gibt keine Rückwärts-Migrationen. Rückgängig machen heißt: neue Migration schreiben,
  oder die D1-Zeitreise nutzen (`wrangler d1 time-travel restore`) — beides ist im Repo nicht geübt
  oder getestet.

## 3. Not-Aus

Registry-Schlüssel **`ablauf.autopilot`** (Gruppe `ablauf`, Standard `an`):

| Wert | Bedeutung |
|---|---|
| `an` | normal |
| `nur_verarbeiten` | bewerten, aber nichts senden |
| `aus` | Eingänge annehmen und parken, nichts läuft an |

Schalten: Admin-Bereich → Einstellungen → `ablauf.autopilot`, oder
`PUT /api/admin/einstellungen/ablauf.autopilot` mit `{ "wert": "aus", "version": <aktuelle Version> }`
(Version aus `GET /api/admin/einstellungen/ablauf.autopilot`; ein veralteter Stand führt zu
`VERSION_KONFLIKT`). Jede Änderung steht mit Admin-Kennung in
`GET /api/admin/einstellungen/ablauf.autopilot/verlauf`. Zurück auf Standard: `"wert": null`.

Wirkung im Code (wird jeweils bei **jedem** Vorgang gelesen, kein Neustart nötig):

| Stelle | Bei `aus` | Bei `nur_verarbeiten` |
|---|---|---|
| [`anfragen/dienst.ts`](../apps/api/src/anfragen/dienst.ts) `reihEin` | neue Anfrage wird gespeichert, **kein** Job eingereiht | Job wird eingereiht |
| [`queue/bewertungs-job.ts`](../apps/api/src/queue/bewertungs-job.ts) | Job kehrt mit „übersprungen“ zurück, Anfrage bleibt unbewertet | läuft normal |
| [`cron/nachholen.ts`](../apps/api/src/cron/nachholen.ts) `holeNach` | reiht nichts nach | reiht nach |
| [`versand/index.ts`](../apps/api/src/versand/index.ts) | Nachricht wird als `geparkt` gespeichert, dann Fehler `AUTOPILOT_GESPERRT` | Nachricht wird als `geparkt` gespeichert, nicht gesendet (kein Fehler) |

Was er **nicht** stoppt: Annahme und Speicherung neuer Eingänge (Formular, E-Mail), Admin-Aktionen
(Freigabe usw.), Alarme, Cron-Aufgaben außer dem Nachholen (z. B. Erinnerungen, Aufräumen),
Freigabe-Benachrichtigungen. Die Freigabepflicht (`ablauf.freigabePflicht`) ist bewusst nicht
abschaltbar.

Wiedereinschalten: auf `an` setzen. Der Cron (alle 15 Minuten) reiht Anfragen im Status
„eingegangen“ nach (`ablauf.nachholenNachMinuten`, höchstens `ablauf.nachholenMaxJeLauf` je Lauf);
geparkte Nachrichten gehen **nicht** automatisch raus — **Lücke:** im Code gibt es keine Route, die
`geparkt`-Nachrichten nachträglich versendet.

## 4. Alarme

Code: [`apps/api/src/alarm/`](../apps/api/src/alarm). Aufruf aus dem Fehlerspeicher
([`fehler/speicher.ts`](../apps/api/src/fehler/speicher.ts)), dem Cron und der Dead-Letter-Queue.

Ein Alarm fällt, wenn **alle** zutreffen:

1. `betrieb.alarmKanal` ist nicht `aus`. Angebunden ist nur `email`; `whatsapp` schreibt
   `ALARM_FEHLGESCHLAGEN` ins Worker-Log und alarmiert nicht.
2. Die Schwere des Fehlercodes (Katalog [`fehler.ts`](../packages/shared/src/fehler.ts)) erreicht
   `betrieb.alarmAbSchwere` (Standard `kritisch`).
3. Der Fingerabdruck (Code + Ort + Meldung) hat in den letzten `betrieb.alarmRuheMinuten` nicht
   schon alarmiert (Tabelle `alarm_ruhe`, atomar beansprucht).

Die Mail geht an `mail.adminEmpfaenger` von `mail.absenderAdresse` (beide in der Registry) und
enthält nur Katalogtext, Code, Schwere, Ort, Korrelations-ID und die ersten zwölf Zeichen des
Fingerabdrucks — keine Meldung, keinen Kontext, keine Personendaten. Sind Absender oder Empfänger
leer, scheitert der Versand mit `ALARM_FEHLGESCHLAGEN`.

Der Alarmweg wirft nie: schlägt er fehl, steht `ALARM_FEHLGESCHLAGEN` im Worker-Log
(`wrangler tail`), und die Ruhezeit wird zurückgenommen, damit der nächste Fehler es erneut versucht.
**Wer nie eine Mail bekommt, prüft zuerst `mail.adminEmpfaenger`, `mail.absenderAdresse`, das
Worker-Log und ob der Kanal `email` ist.**

Weitere Quellen:

| Quelle | Schalter | Hinweis |
|---|---|---|
| Dead-Letter-Queue | `betrieb.deadLetterAlarmAb` (Anzahl offener Einträge) | siehe 5 |
| Cron-Aufgabe scheitert | `betrieb.fehlerSpeichernAbSchwere` | Code `CRON_FEHLGESCHLAGEN`, Lauf steht in `cron_laeufe` |
| Geparkte Eingänge (Flutschutz) | — | Code `ZU_VIELE_ANFRAGEN`, gemeldet vom Cron |
| Offene Freigaben | `benachrichtigung.kanal`, `benachrichtigung.erinnerungNachStunden`, `benachrichtigung.eskalationNachStunden` | Stufen neu / Erinnerung / Eskalation, je Anfrage und Generation eine Mail |

Fehlerspeicher ansehen und quittieren: `GET /api/admin/fehler`, `POST /api/admin/fehler/:id/quittieren`.
Cron-Läufe: Tabelle `cron_laeufe` (**Lücke:** keine Admin-Route dafür; Einsicht nur per
`wrangler d1 execute`). Einzelne Cron-Aufgaben abschalten: `betrieb.cronAufgaben`.

## 5. Wiederanlauf aus der Dead-Letter-Queue

Wenn ein Bewertungsjob nach `max_retries` (Plattform, 3) endgültig scheitert, landet er in
`bewertung-dead-letter`. Der Consumer [`queue/dead-letter.ts`](../apps/api/src/queue/dead-letter.ts):

1. legt den Job in der Tabelle `dead_letter` ab (je Nachrichten-ID einmal, idempotent),
2. setzt die Anfrage, wenn sie noch in `in_bewertung` der gleichen Generation steht, per
   `fehlschlag` auf `fehlgeschlagen` (Ereignis-Notiz `DEAD_LETTER`),
3. schreibt `DEAD_LETTER` in den Fehlerspeicher,
4. alarmiert ab `betrieb.deadLetterAlarmAb` offenen Einträgen.

Vorgehen:

1. Offene Einträge: `GET /api/admin/dead-letter` (mit `?alle=1` auch bereits erneut eingereihte;
   höchstens 200, neueste zuerst). Einzeln: `GET /api/admin/dead-letter/:id` (Nutzlast als JSON).
2. **Ursache klären** (Fehlerspeicher, Worker-Log über die `korrelation` des Eintrags). Wer ohne
   Behebung erneut einreiht, erzeugt denselben Eintrag noch einmal.
3. Erneut einreihen: `POST /api/admin/dead-letter/:id/erneut`. Der Code erhöht die Generation der
   Anfrage und schickt einen neuen Job; der Eintrag trägt `erneut_am`, `erneut_von` (Admin) und
   `erneut_generation`. Ein zweiter Aufruf (auch gleichzeitig) sendet nichts mehr und liefert
   `bereitsEingereiht: true`. Scheitert das Einreihen, wird die Beanspruchung zurückgenommen und der
   Fehler gemeldet; dann ist ein neuer Versuch möglich.
4. Fehler: Eintrag ohne Anfrage → `EINGABE_UNGUELTIG`; Anfrage inzwischen gelöscht → `NICHT_GEFUNDEN`.

Bei `ablauf.autopilot = aus` läuft der neue Job an, kehrt aber „übersprungen“ zurück (siehe 3).
**Lücke:** Es gibt keine Sammel-Route („alle erneut“) und keine Route zum Verwerfen eines Eintrags;
nicht mehr gewollte Einträge bleiben offen und zählen zur Alarmschwelle.

## 6. DSGVO: Auskunft und Löschung

### Wo Personendaten liegen

| Tabelle / Speicher | Personenbezug | Löschung im Code |
|---|---|---|
| `anfragen` | `kunde_name`, `kunde_kontakt`, `dubletten_schluessel`; `fahrzeug` (JSON, Fahrzeugdaten) | Cron `dsgvoLoeschung`: die drei Personenfelder werden `NULL`, `personendaten_geloescht_am` gesetzt; die Anfrage bleibt anonym. `fahrzeug` bleibt |
| `anfrage_nachrichten` | Freitext des Kunden | Cron: Zeilen gelöscht |
| `nachrichten` (Versandprotokoll) | `kontakt`, `inhalt` | Cron: beide Felder auf `''` |
| `anfrage_ereignisse` | `notiz` (Freitext), `durch` (Admin-Kennung) | Cron: `notiz` auf `NULL`; `durch` bleibt |
| `eingang_geparkt` | `kontakt`, `nutzlast` (JSON der Eingabe) | Cron: Zeilen gelöscht, **ab Erstellung** gezählt |
| `email_eingang`, `email_anhaenge` + R2-Objekte (`r2_schluessel`) | Message-ID, Dateiname, Anhang (Fahrzeugfotos/-papiere) | Cron und Einzellöschung: Zeilen gelöscht, R2-Objekte zuerst gelöscht |
| `berichte` + HTML in D1 oder R2 (`berichte/<anfrageId>/<generation>.html`) | Bewertungsbericht zur Anfrage (HTML) | Cron und Einzellöschung: `html` und `r2_schluessel` auf `NULL`, R2-Objekt gelöscht; Zahlen und Eingabe (Fahrzeug) bleiben für die Auswertung |
| `ki_nutzung` | nur `anfrage_id`, Zähler, Kosten | nicht personenbezogen im engeren Sinn, keine Löschung |
| `geraete`, `kopplungscodes` | Gerätename, Token-/Code-**Hash**, optional Push-Token | Gerät widerrufbar (`widerrufen_am`); Push-Token bleibt stehen |
| `dead_letter` | Nutzlast ist der Job (Anfrage-ID, Generation, Korrelation) | keine Löschung |
| `fehler_ereignisse` | Code, Ort, geschwärzter Kontext | Cron `fehlerAufraeumen` nach `betrieb.fehlerAufbewahrungTage` |

### Automatische Löschung (Aufbewahrung)

Cron-Aufgabe **`dsgvoLoeschung`** ([`cron/aufgaben.ts`](../apps/api/src/cron/aufgaben.ts)), alle 15
Minuten, schaltbar in `betrieb.cronAufgaben`. Betrifft Anfragen im Endstatus `angekauft`,
`abgesagt` oder `abgelehnt`, deren letzte Änderung länger als
**`betrieb.personendatenAufbewahrungTage`** zurückliegt. Alles läuft in einem Batch; der Marker
`personendaten_geloescht_am` macht jeden weiteren Lauf zum No-op. Anfragen in anderen Status werden
**nicht** gelöscht, auch nicht nach Ablauf der Frist.

Kontrolle: letzte Läufe in `cron_laeufe`, z. B.

```powershell
npx wrangler d1 execute kfz-bewertung --remote --command "SELECT beginn, status, bearbeitet FROM cron_laeufe WHERE aufgabe = 'dsgvoLoeschung' ORDER BY beginn DESC LIMIT 5"
```

### Auskunft (Art. 15)

`POST /api/admin/dsgvo/auskunft` mit `{ "kontakt": "<E-Mail oder Telefon>" }` (Groß-/Kleinschreibung egal).
Der Kontakt steht im Body, nicht in der URL, damit er in keinem Zugriffsprotokoll landet. Die Antwort
enthält alles zum Kontakt über alle Tabellen: `anfragen`, `nachrichtenVomKunden`, `ereignisse`,
`versandteNachrichten`, `geparkteEingaenge`, `emailEingang`, `anhaenge` (nur Verzeichnis: Name, Typ, Größe),
`berichte` (ohne HTML) und `ankaeufe`. Unbekannter Kontakt: `NICHT_GEFUNDEN`. Mehr Treffer als
`betrieb.dsgvoAuskunftMaxAnfragen`: `abgeschnitten: true`. Die Anhänge selbst liefert
`GET /api/admin/geparkt/:id/anhaenge/:anhangId`.

### Löschung auf Anfrage (Art. 17)

`POST /api/admin/dsgvo/loeschung` mit `{ "kontakt": "…", "bestaetigung": "…" }`; die Bestätigung muss den
Kontakt wiederholen. Gelöscht wird sofort und für alle Anfragen und geparkten Eingänge der Person:
dieselben Felder wie im Cron (siehe Tabelle), dazu das Versandprotokoll über den Kontakt. Die Anfragen
bleiben anonym erhalten und tragen ein Ereignis `dsgvo_geloescht` mit der Admin-Kennung (ohne Personenbezug).

| Fall | Ergebnis |
|---|---|
| Kontakt unbekannt, auch beim zweiten Aufruf | `NICHT_GEFUNDEN`; nichts ändert sich |
| Bestätigung weicht ab | `EINGABE_UNGUELTIG` |
| `betrieb.dsgvoEinzelloeschungOffeneAnfragen` = `sperren` und eine Anfrage nicht im Endstatus | `DSGVO_OFFENE_ANFRAGE` |
| R2 nicht erreichbar | `DSGVO_LOESCHUNG_FEHLGESCHLAGEN` (wiederholbar); die Datenbank bleibt unberührt, der Aufruf kann wiederholt werden |

Push-Token liegen an Geräten der Admin-App (`geraete`), nicht an Kunden, und gehören nicht zur Löschung einer
Kundin oder eines Kunden.

## 7. Weiterführend

### Rate-Limits

Code: [apps/api/src/ratelimit/index.ts](../apps/api/src/ratelimit/index.ts), Zähler in der D1-Tabelle
`ratenzaehler` ([Migration 0013](../apps/api/migrations/0013_ratenbegrenzung.sql)), Tests in
[rate-limit.test.ts](../apps/api/test/rate-limit.test.ts). Feste Fenster je Absender und Kanal; der
Absender (`CF-Connecting-IP`, bei Mails die Absenderadresse) liegt nur als Hash vor. Die Grenzen sind
Einstellungen und ohne Deploy änderbar:

| Kanal | Wo | Schlüssel | Standard | Bei Überschreitung |
|---|---|---|---|---|
| `formular` | `/api/anfragen` | `ratenlimit.formular.max` / `.fensterSekunden` | 10 je 3600 s | 429 `RATE_LIMIT_UEBERSCHRITTEN`, Header `Retry-After` |
| `email` | E-Mail-Eingang | `ratenlimit.email.max` / `.fensterSekunden` | 20 je 3600 s | Mail wird verworfen, ohne zu antworten |
| `app` | `/api/app/*` | `ratenlimit.app.max` / `.fensterSekunden` | 120 je 60 s | 429 `RATE_LIMIT_UEBERSCHRITTEN`, Header `Retry-After` |

Fehlt die Client-IP (lokaler Aufruf, Tests), wird nicht gezählt. Alte Fenster eines Kanals räumt der
nächste Aufruf desselben Kanals. Legitime Kundschaft hinter einer gemeinsamen IP (Firmennetz) trifft das
Formular-Limit früher: `ratenlimit.formular.max` per Einstellung anheben.

### Lasttest

[lasttest-bewertungs-job.test.ts](../apps/api/test/lasttest-bewertungs-job.test.ts) läuft mit `npm test`:
500 Anfragen über die Mock-Quelle, doppelt zugestellte Queue-Nachrichten und parallele Batches; jede Anfrage
wird genau einmal bewertet. Laufzeitrahmen 120 s (fängt quadratisches Verhalten oder hängende
Wiederholungen, keine Millisekunden). Er prüft die Verarbeitung, nicht den Durchsatz am echten Netz oder
gegen echte Portale.

### OpenAPI

`npm run openapi` erzeugt [docs/openapi.json](openapi.json) aus den zod-Schemas; ein Test prüft Aktualität
und Vollständigkeit.

### Sicherheits-Befunde

Der Review nach OWASP API Security Top 10 steht in [SICHERHEIT.md](SICHERHEIT.md): 18 Befunde je Route, Queue und
Cron mit Stand (behoben, akzeptiert, in Ordnung) und Test; keine hohen oder mittleren Befunde offen. Behoben wurden
Body-Limit, Sicherheits-Header, fester JWT-Algorithmus und die Auslieferung von Mail-Anhängen.

Für den Betrieb neu: Registry-Schlüssel `sicherheit.bodyMaxBytes` (Standard 256 KiB) begrenzt JSON-Bodys; wird er
überschritten, antwortet die API mit `ANFRAGE_ZU_GROSS` (413, Schwere `info`, nicht wiederholbar) — das ist kein
Fehler im Betrieb, sondern eine abgewiesene Anfrage. Bei legitim größeren Bodys den Schlüssel anheben (bis 5 MiB).
