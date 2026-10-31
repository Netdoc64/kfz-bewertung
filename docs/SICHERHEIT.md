# Sicherheits-Review (OWASP API Security Top 10, 2023)

Geprüft: alle Routen aus `apps/api/src/index.ts` — öffentlich (`/api/anfragen`, `/api/gesundheit`),
Admin (`/api/admin/*` hinter Cloudflare Access), App (`/api/app/*` mit Geräte-Token) — sowie der
E-Mail-Eingang, der Queue-Eingang und der Cron. Inventar der Endpunkte: [openapi.json](openapi.json)
(`npm run openapi`, die CI prüft die Aktualität).

Stand je Befund: **behoben** (mit Test), **akzeptiert** (mit Begründung) oder **offen**.
Tests liegen in `apps/api/test/sicherheit-*.test.ts`.

## Befunde

| Nr | OWASP | Befund | Stand | Fix / Begründung | Test |
|---|---|---|---|---|---|
| S1 | API4 Ressourcenverbrauch | Kein Größenlimit für JSON-Bodys; ein großer Body wurde vollständig gelesen und geparst | **behoben** | Middleware `bodyBegrenzung` für alle Schreibaufrufe unter `/api/*`; Grenze `sicherheit.bodyMaxBytes` (Registry), Fehler `ANFRAGE_ZU_GROSS` (413); greift mit `Content-Length` und beim Lesen eines Stroms | `sicherheit-header-body` |
| S2 | API8 Fehlkonfiguration | Keine Sicherheits-Header (nosniff, Frame, Cache, CSP) | **behoben** | Middleware `sicherheitsKopfzeilen` setzt `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cache-Control: no-store`, `Content-Security-Policy` (`default-src 'none'; sandbox`), HSTS auf jede Antwort, auch Fehler und selbst gebaute Responses | `sicherheit-header-body` |
| S3 | API2 Broken Authentication | Access-JWT wurde ohne festen Algorithmus geprüft | **behoben** | Nur `RS256` (wie Cloudflare Access); Kopf wird vor der Prüfung gelesen, `none`/`HS256` kommen nicht bis `jwtVerify` | `sicherheit-auth` |
| S4 | API2 Broken Authentication | Anhang aus einer Mail wird mit dem Medientyp des Absenders ausgeliefert | **behoben** | Zusätzlich zu `attachment` und `nosniff` jetzt CSP `sandbox` auf jeder Antwort; Dateiname wird URL-kodiert (kein Header-Umbruch) | `sicherheit-ablaeufe` |
| S5 | API2 Broken Authentication | Access-JWT: Signatur, Aussteller, Audience, Ablauf, E-Mail | in Ordnung | `jose` prüft Signatur gegen die JWKS des Teams, `issuer`, `audience`, `exp`; ohne `ACCESS_*` verweigert die Produktion den Admin-Bereich (fail closed). Der Entwicklungsmodus (`UMGEBUNG=entwicklung`) umgeht Access bewusst; die oberste `wrangler.jsonc`-Ebene ist Produktion | `sicherheit-auth` |
| S6 | API1 BOLA | Geräte und Admins sehen alle Anfragen | **akzeptiert** | Ein Mandant, ein Betrieb: jeder Admin und jedes gekoppelte Gerät darf alle Anfragen bearbeiten. Objekte sind nur über IDs erreichbar, unbekannte IDs ergeben 404; Anhänge nur über ihren Eingang (`geparkt_id` + `anhang_id`) | `sicherheit-ablaeufe` |
| S7 | API3 BOPLA / Mass Assignment | Eingeschleuste Felder (`status`, `id`, `version`, `preis`) | in Ordnung | Alle Eingaben laufen durch zod-Objektschemas, unbekannte Felder werden verworfen; Status, Version und Kanal setzt nur der Server. Die Antwort an Unbekannte enthält nur `id` und `status` | `sicherheit-ablaeufe` |
| S8 | API5 BFLA | Geräte-Token oder fehlendes Token am Admin-Bereich | in Ordnung | `/api/admin/*` verlangt Access-JWT; alle 19 Admin-Routen werden einzeln auf 401 geprüft. Das Gerät erreicht nur `/api/app/*` | `sicherheit-auth` |
| S9 | API6 Sensible Abläufe | Preis ohne Freigabe | in Ordnung | `angebot_senden` ist nur aus `freigegeben` zulässig (also erst nach der Admin-Freigabe) (Zustandsautomat in `@kfz/shared`), über Admin- wie App-Weg; der Not-Aus `ablauf.autopilot` wird beim Versand geprüft; Ankaufspreis wird numerisch validiert | `sicherheit-ablaeufe`, `e2e-freigabe` |
| S10 | API4 Ressourcenverbrauch | Missbrauch von Formular, E-Mail, App-API und Kopplungscode | in Ordnung | Rate-Limits je Absender, Grenzen aus der Registry (`ratenlimit.*`); Kopplungscode 12 Zeichen aus 32 (60 Bit), einmalig, befristet, gehasht | `rate-limit`, `geraete` |
| S11 | API4 Ressourcenverbrauch | E-Mail: Größe und Anhänge | in Ordnung | `mail.maxGroesseBytes`, `mail.anhangMaxAnzahl`, `mail.anhangMaxBytes`, `mail.anhangTypen` aus der Registry; Absender-Rate-Limit | `email-eingang` |
| S12 | API7 SSRF | Server ruft URLs auf, die der Aufrufer liefert | in Ordnung | Keine Route nimmt eine URL entgegen. Ausgehende Aufrufe gehen nur an feste Ziele (Manager-URL aus der Umgebung, Anthropic, FCM, Access-JWKS des konfigurierten Teams) | `sicherheit-ablaeufe` (Quellscan der Routen) |
| S13 | API8 Fehlkonfiguration | CORS | in Ordnung | Keine CORS-Freigabe; Admin-Web und App rufen vom selben Ursprung bzw. nativ | `sicherheit-header-body` |
| S14 | API8 Fehlkonfiguration | Fehlerantworten verraten Interna oder Eingaben | in Ordnung | 5xx zeigen nur den Katalogtext; zod-Meldungen enthalten keine Eingabewerte; Korrelations-ID wird gegen ein festes Muster geprüft; Fehlerkontext ohne Geheimnisse und Personendaten (Ratenlimit speichert nur gekürzten Hash) | `sicherheit-ablaeufe`, `rate-limit` |
| S15 | API8 Fehlkonfiguration | `/api/gesundheit` nennt die Umgebung (`produktion`/`entwicklung`) | **akzeptiert** | Keine Geheimnisse, kein Mehrwert für Angreifer; Betriebsüberwachung nutzt den Wert | — |
| S16 | API9 Inventar | Undokumentierte Endpunkte | in Ordnung | `docs/openapi.json` wird aus den Routen und zod-Schemas erzeugt, ein Test bricht bei Abweichung; unbekannte Pfade ergeben 404 | `openapi` |
| S17 | API10 Unsichere Fremd-APIs | Antworten von Manager, KI und FCM | in Ordnung | KI nur für Auslesen/Formulieren, nie für den Preis; Antworten werden gegen Schemas geprüft, Mail-Text wird nie als Anweisung ausgeführt; Manager-Aufrufe sind HMAC-signiert | `ki-injection`, `versand` |
| S18 | Queue-/Cron-Eingang | Manipulierte Queue-Nachrichten | in Ordnung | Queue und Cron sind nur intern erreichbar (kein HTTP); Jobs tragen die Generation und werden bei Abweichung verworfen | `bewertungs-job`, `dead-letter` |

## Offen

Keine hohen oder mittleren Befunde offen. Beim nächsten Review zu beobachten: Kosten durch viele
kleine Schreibaufrufe am Admin-Bereich (nur über Access erreichbar, kein Rate-Limit nötig).

## Neue Grenzwerte und Fehlercodes

| Art | Name | Wert |
|---|---|---|
| Registry | `sicherheit.bodyMaxBytes` | 262144 (256 KiB), einstellbar bis 5 MiB |
| Fehlercode | `ANFRAGE_ZU_GROSS` | 413, Schwere `info`, nicht wiederholbar |
