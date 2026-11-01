# kfz-bewertung — Regeln für jede Änderung

Gesamtbild und Phasen: [PLAN.md](PLAN.md).

## Dynamic first — verbindlich

- **Keine fachliche Zahl, kein Schwellwert, kein Kundentext im Code.** Prozentsätze,
  Pauschalen, Toleranzen, Mindestanzahlen, Fristen, Vorlagentexte, Beschriftungen:
  alles kommt aus der Registry `packages/shared/src/einstellungen.ts` und wird zur
  Laufzeit über `einstellungen.lese("…")` gelesen.
- Braucht eine Änderung einen neuen Wert: **neuen Schlüssel in der Registry anlegen**
  (Schema, Standardwert, Beschreibung, Gruppe) — nicht eine Konstante in der Datei.
- Bestehende Schlüssel nie umbenennen oder den Typ ändern, ohne Migration in
  `apps/api/migrations/`. Gespeicherte Werte in D1 müssen weiter gültig bleiben.
- Erlaubt im Code: technische Konstanten ohne fachliche Bedeutung (HTTP-Status,
  Tabellennamen, Feldnamen).

## Fehler

- Jeder Fehler ist ein `AppFehler` mit Code aus `packages/shared/src/fehler.ts`.
  Kein `throw new Error("…")` in fachlichem Code, keine eigenen Fehlerformate in Routen.
- Neuer Fehlerfall → neuer Code im Katalog (Status, Schwere, wiederholbar, Nutzertext).
- Kontext an Fehlern nie mit Geheimnissen oder Personendaten füllen; der Speicher
  schwärzt zusätzlich, verlass dich nicht darauf.

## Bewertung und KI

- Die Bewertung läuft ohne KI. KI nur über den `KiAnschluss`-Port und nur für
  Auslesen/Formulieren — **nie** für den Preis.
- Kein Preis ohne Freigabe: Nachrichten ohne Preis (Eingang, Rückfrage,
  Datenschutzhinweis) dürfen automatisch aus Vorlagen raus, alles mit Preis oder
  Zusage erst nach Admin-Freigabe. Der Not-Aus `ablauf.autopilot` wird bei jedem
  Versand geprüft.
- Im Zweifel `an_mensch` mit Grund — nie raten, nie still scheitern.

## Mergen — volle Autonomie

- In diesem Repo gibt es **keine Pfade mit Mensch-Pflicht**. Auch Änderungen unter
  `.github/`, an Migrationen, Auth oder Geld mergt die Session bzw. der Orchester
  selbst, sobald die Pflichtprüfung `test` grün ist.
- Kein Label `nur-mensch` setzen und kein Thema als „Mensch“ markieren, nur weil
  es solche Pfade berührt. Grenzen bleiben: keine Geheimniswerte, kein Geld bewegen,
  keine Konten anlegen.

## Fertig heißt

Jede Phase hat Fertig-Kriterien in [PLAN.md](PLAN.md). Eine Phase ist erst fertig,
wenn alle abgehakt sind und `npm test`, `npm run typecheck` und
`wrangler deploy --dry-run` grün laufen.

## Geheimnisse

- Nie Werte in Dateien schreiben. Namen stehen in `apps/api/.dev.vars.example`,
  die Werte verteilt der Business Manager.
