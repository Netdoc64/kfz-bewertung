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
