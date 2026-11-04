# Startklar — vom Repo zum ersten echten Betrieb

Jeder Schritt, den nur ein Mensch tun kann, in der Reihenfolge, in der er geht. Zu jedem
Schritt gibt es einen Prüfbefehl (Windows PowerShell 5.1). Der Rest — Migrationen, Deploy,
Rauchtest — macht der [Deploy-Workflow](../.github/workflows/deploy.yml). Betrieb danach:
[BETRIEB.md](BETRIEB.md).

Grundregel: **Werte von Geheimnissen schreibt niemand von Hand in eine Datei.** Der
Business Manager verteilt sie; hier stehen nur Namen (aus
[`apps/api/.dev.vars.example`](../apps/api/.dev.vars.example)).

| Nr. | Schritt | Prüfbefehl |
|---|---|---|
| 1 | Cloudflare-Konto | `npx wrangler whoami` |
| 2 | Ressourcen anlegen | `npm run einrichten` |
| 3 | IDs in `wrangler.jsonc` | `node packages/betrieb/src/platzhalter.mjs vorschau` |
| 4 | Access-App | `node packages/betrieb/src/platzhalter.mjs produktion` |
| 5 | Email Routing | Testmail, dann Admin prüfen |
| 6 | Schlüssel über den Business Manager | `npx wrangler secret list` |
| 7 | GitHub-Secrets | `gh secret list` |
| 8 | Manager-Endpunkt | Testversand |
| 9 | mobile.de | `quelleModus` in `/api/gesund` |
| 10 | Erster Start, Autopilot aus, dann an | `npm run rauchtest -- <url>` |

## 1. Cloudflare-Konto

Konto anlegen bzw. anmelden. Einen API-Token mit Rechten für Workers, D1, Queues und R2
erstellen — der Wert geht später in Schritt 7, nicht in eine Datei.

```powershell
npx wrangler login
npx wrangler whoami
```

Erwartet: Konto-Name und Account-ID werden angezeigt.

## 2. Ressourcen anlegen

Legt D1, Queues (samt Dead-Letter) und R2-Bucket je Umgebung an. Idempotent: Vorhandenes
wird nur gemeldet. Gibt die D1-IDs aus, schreibt aber nichts in die Konfiguration.

```powershell
npm run einrichten
```

Erwartet: je Umgebung „angelegt“ oder „vorhanden“ und je D1 eine ID. Ein zweiter Lauf legt
nichts neu an.

## 3. IDs in `wrangler.jsonc` eintragen

Die ausgegebenen `database_id`-Werte in [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc)
eintragen (Produktion: oberste Ebene, Vorschau: `env.vorschau`). Die ID ist kein Geheimnis.

```powershell
node packages/betrieb/src/platzhalter.mjs vorschau; "Exit: $LASTEXITCODE"
```

Erwartet: Exit 0 nur, wenn weder eine Null-ID noch leere `ACCESS_*`-Werte stehen. Solange
Schritt 4 fehlt, meldet die Sperre die `ACCESS_*`-Werte als offen — das ist gewollt.

## 4. Access-App (Admin-Schutz)

Im Cloudflare-Zero-Trust-Dashboard eine Self-hosted-Access-App für die Worker-Adresse
anlegen (Admin-Oberfläche und `/api/admin/*`), Richtlinie: nur die Betreiber-Adressen.
Danach in `wrangler.jsonc` eintragen:

| Variable | Woher |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Team-Domain (`<team>.cloudflareaccess.com`) |
| `ACCESS_AUD` | Application Audience (AUD) Tag der Access-App |

Beides sind keine Geheimnisse. Ohne sie verweigert der Admin-Bereich bewusst jeden Zugriff.

```powershell
node packages/betrieb/src/platzhalter.mjs produktion; "Exit: $LASTEXITCODE"
```

Erwartet: Exit 0.

## 5. Email Routing

Im Cloudflare-Dashboard unter der Domain Email Routing aktivieren, die Eingangsadresse auf
den Worker `kfz-bewertung` leiten und die Absenderadresse für `send_email` (Binding
`EMAIL`) verifizieren. Danach eine Testmail an die Eingangsadresse schicken.

Prüfung: Die Mail erscheint im Admin unter den Anfragen bzw. geparkten Eingängen; im
Worker-Log (`npx wrangler tail`) steht kein Fehler.

## 6. Schlüssel über den Business Manager

Im Business Manager (Reiter „Schlüssel“, **MCP-Zugang** vom Menschen eingeschaltet) die Namen
aus `.dev.vars.example` prägen und an den Worker verteilen:

| Name | Zweck |
|---|---|
| `MOBILEDE_BENUTZER`, `MOBILEDE_PASSWORT` | mobile.de-Search-API (Schritt 9) |
| `WEBHOOK_HMAC_SCHLUESSEL` | Signatur des WhatsApp-Webhooks vom Manager |
| `MANAGER_VERSAND_URL`, `MANAGER_VERSAND_HMAC_SCHLUESSEL` | Versand über den Manager (Schritt 8) |
| `KI_API_SCHLUESSEL` | Auslesen/Formulieren; ohne ihn läuft der Ablauf ohne KI |
| `PUSH_FCM_PROJEKT`, `PUSH_FCM_DIENSTKONTO` | Push an die Admin-App |
| `TURNSTILE_GEHEIMNIS` | Bot-Schutz am Kundenformular |

Der öffentliche Turnstile-Site-Key ist kein Geheimnis: Registry-Schlüssel
`formular.turnstileSiteKey` (Admin → Einstellungen). Ohne ihn zeigt `/formular` kein Widget.

```powershell
cd apps/api
npx wrangler secret list
cd ..\..
```

Erwartet: die Namen stehen in der Liste (Werte zeigt wrangler nie).

## 7. GitHub-Secrets für den Deploy

Im Repository unter Settings → Secrets and variables → Actions:

| Art | Name | Inhalt |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Token aus Schritt 1 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Account-ID aus `wrangler whoami` |
| Variable | `RAUCHTEST_URL_PRODUKTION` | Worker-Adresse Produktion |
| Variable | `RAUCHTEST_URL_VORSCHAU` | Worker-Adresse Vorschau |

Fehlt `CLOUDFLARE_API_TOKEN`, überspringt der Deploy-Workflow alles mit Hinweis und bleibt
grün. Fehlt die Rauchtest-Variable, entfällt nur der Rauchtest.

```powershell
gh secret list
gh variable list
```

Erst die Vorschau ausprobieren (Actions → Deploy → Run workflow → `vorschau`); Produktion
läuft danach automatisch nach grünem `test` auf `main`.

## 8. Manager-Endpunkt

Im Business Manager muss `POST /kfz/versand` gebaut sein; Vertrag:
[manager-versand.md](manager-versand.md), Gegenrichtung (Webhook):
[manager-webhook.md](manager-webhook.md). `MANAGER_VERSAND_URL` und beide HMAC-Schlüssel
kommen aus Schritt 6.

Prüfung: Eine Anfrage ohne Preis (Eingangsbestätigung) auslösen; sie erscheint als versandte
Nachricht im Admin. Bleibt sie „fehlgeschlagen“, stimmen URL oder Schlüssel nicht.

## 9. mobile.de

Zugang zur mobile.de-Search-API beantragen; die Zugangsdaten gehen über den Business
Manager (Schritt 6). Solange `quelle.mobilede.modus` = `mock` ist, entsteht in Produktion
**kein Preis**: die Anfrage geht mit Grund an `an_mensch`, der Admin zeigt „keine
Live-Daten“. Erst mit Zugangsdaten im Admin `quelle.mobilede.modus` auf `live` setzen.

```powershell
(Invoke-RestMethod "https://<worker-adresse>/api/gesund").quelleModus
```

Erwartet: `live`.

## 10. Erster Start: Autopilot aus, dann an

`ablauf.autopilot` ist der Not-Aus und wird bei jedem Versand geprüft. Beim ersten Start
**aus** lassen:

```powershell
npm run rauchtest -- https://<worker-adresse>
(Invoke-RestMethod "https://<worker-adresse>/api/gesund").autopilot
```

Erwartet: „Rauchtest bestanden.“ und `autopilot` = `False`. Dann eine Testanfrage über
`/formular` stellen und den Weg im Admin verfolgen (Eingang, Bewertung, Freigabe).
Nachrichten ohne Preis dürfen automatisch raus, alles mit Preis erst nach Freigabe. Läuft das
sauber, im Admin `ablauf.autopilot` auf `true` setzen und erneut prüfen:

```powershell
(Invoke-RestMethod "https://<worker-adresse>/api/gesund").autopilot
```

Erwartet: `True`. Notbremse jederzeit: wieder auf `false` (siehe [BETRIEB.md](BETRIEB.md) §3).
