# kfz-bewertung

Autonome Fahrzeugbewertung für Kundenanfragen auf Basis von mobile.de-Vergleichsinseraten,
mit Admin-Freigabe und Ankaufsabwicklung. Plan und Randfälle: [PLAN.md](PLAN.md),
Regeln für Änderungen: [CLAUDE.md](CLAUDE.md).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `packages/shared` | Fehlerkatalog, Einstellungs-Registry, Fahrzeugschema, Statusmaschine, KI-Port |
| `apps/api` | Cloudflare Worker (Hono, D1) |

## Lokal

```powershell
npm install
npm test
npm run typecheck
npm run db:migrate:lokal -w @kfz/api
npm run dev:api
```

## Android-APK (Phase 7)

Die Admin-Oberfläche läuft als Capacitor-App (`apps/admin/android/`). Die API-Adresse steht nicht im Build, sie kommt aus der Geräte-Kopplung.

Voraussetzungen: JDK 21 (`JAVA_HOME`) und Android SDK (`ANDROID_HOME`, mit Plattform und Build-Tools). Fehlt eine Variable, sucht `apps/admin/scripts/apk.mjs` an den üblichen Orten (Android Studio, `%LOCALAPPDATA%\Android\Sdk`); wird nichts gefunden, bricht es mit Hinweis ab.

```powershell
npm ci
npm run apk -w @kfz/admin
```

Ergebnis: `apps/admin/android/app/build/outputs/apk/debug/app-debug.apk`. Das Skript baut das Web-Bündel (`vite build`), führt `cap sync android` aus und ruft `gradlew assembleDebug`.
## KI-Anschluss (Phase 6)

Die KI hängt hinter dem Port `KiAnschluss` (Adapter für das offizielle `@anthropic-ai/sdk`, `apps/api/src/ki/`). Sie liest Freitext und Fahrzeugschein-Fotos aus, ordnet Mails ein und formuliert den Berichtstext — **nie** den Preis; der kommt allein aus dem Bewertungskern. Modell, Aufwand, Fähigkeiten, Mindest-Sicherheit und Tagesbudget stehen in der Registry (`ki.*`); `ki.aktiv=false` oder ein fehlender Schlüssel ergibt den Ablauf ohne KI.

Der Schlüssel heißt `KI_API_SCHLUESSEL` (nur der Name steht in `apps/api/.dev.vars.example`, den Wert verteilt der Business Manager). Tests laufen gegen eine Attrappe und brauchen keinen Schlüssel; `apps/api/test/ki-injection.test.ts` belegt, dass Anweisungen in einer Kundenmail weder Preis noch Status noch Empfänger ändern.

## App-API (Phase 7)

Geräte koppeln sich mit einem Kopplungscode und arbeiten danach mit einem Geräte-Token (`Authorization: Bearer …`, nur gehasht in D1, widerrufbar).

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/app/koppeln` | `{ code, name }` gegen Geräte-Token tauschen (ohne Token) |
| POST | `/api/app/push-token` | Push-Token des Geräts speichern |
| GET | `/api/app/beschriftungen` | Beschriftungen und Statusnamen für die App |
| GET | `/api/app` | Anfragenliste |
| GET | `/api/app/:id` | Anfrage-Detail |
| POST | `/api/app/:id/aktion` | Freigabe-Aktionen, Ankaufspreis erfassen (wie im Admin) |
| GET | `/api/admin/geraete` | Geräte auflisten |
| POST | `/api/admin/geraete/kopplungscode` | Kopplungscode erzeugen |
| POST | `/api/admin/geraete/:id/widerrufen` | Gerät sperren |

## API (Phase 0)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/gesundheit` | Lebenszeichen inkl. DB-Prüfung |
| GET | `/api/admin/einstellungen` | Alle Einstellungen mit Standard, Version, Quelle, Abdruck |
| GET | `/api/admin/einstellungen/:schluessel` | Ein Eintrag |
| PUT | `/api/admin/einstellungen/:schluessel` | `{ wert, version }` setzen, `wert: null` = Standard |
| GET | `/api/admin/einstellungen/:schluessel/verlauf` | Änderungsverlauf |
| GET | `/api/admin/fehler` | Fehlerspeicher, Filter `offen`, `abSchwere`, `grenze` |
| POST | `/api/admin/fehler/:id/quittieren` | Fehler quittieren |

`/api/admin/*` liegt in Produktion hinter Cloudflare Access (JWT wird im Worker geprüft).
