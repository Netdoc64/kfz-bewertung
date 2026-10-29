# Versand-Schnittstelle Business Manager ⇄ kfz-bewertung

Vertrag für den `ManagerKanal`-Adapter (Phase 4). kfz-bewertung ruft, der Manager
sendet WhatsApp mit **seinen** Regeln (Ruhezeiten, Pausen, Übergabe). Kein Preis
ohne Freigabe bleibt Sache von kfz-bewertung: der Manager bekommt nur Text, der
dort schon freigegeben ist.

## Endpunkt

`POST {MANAGER_VERSAND_URL}/kfz/versand` — Body `application/json`, UTF-8, höchstens 16 KiB.

```json
{
  "kanal": "whatsapp",
  "an": "+491701234567",
  "text": "Guten Tag, …",
  "korrelation": "nachricht-<uuid>"
}
```

| Feld | Regel |
|---|---|
| `kanal` | heute nur `whatsapp` (E-Mail sendet kfz-bewertung selbst) |
| `an` | E.164, mit führendem `+` |
| `text` | 1–4096 Zeichen, fertig formuliert; der Manager ändert ihn nicht |
| `korrelation` | ID der Nachricht in `nachrichten`; zugleich **Idempotenzschlüssel** |

## Auth: HMAC + Zeitstempel

Kopfzeilen:

| Kopfzeile | Inhalt |
|---|---|
| `X-Kfz-Zeitstempel` | Unix-Sekunden, UTC |
| `X-Kfz-Signatur` | `sha256=` + Hex von HMAC-SHA256 |

Signiert wird `"{zeitstempel}.{rohkörper}"` (Rohbytes des Bodys, wie gesendet) mit
`MANAGER_VERSAND_HMAC_SCHLUESSEL`. Der Manager prüft:

1. Zeitstempel höchstens 300 s von seiner Uhr entfernt (Wert im Manager konfiguriert), sonst `401 ZEITSTEMPEL_ABGELAUFEN`.
2. Signatur mit konstantzeitigem Vergleich, sonst `401 SIGNATUR_UNGUELTIG`.
3. `korrelation` schon gesehen → die **erste** Antwort erneut liefern, nichts senden (Wiederholung ist sicher).

Der Schlüssel ist getrennt vom `WEBHOOK_HMAC_SCHLUESSEL` (Eingang Manager → kfz-bewertung); je Richtung ein Schlüssel.

## Antwort

Erfolg `200`:

```json
{ "ok": true, "externeId": "wamid.…", "zustand": "gesendet" }
```

`zustand`: `gesendet` oder `eingereiht` (Manager hält wegen Ruhezeit/Pause zurück und sendet später; Zustellung ist dann nicht sofort). Beides gilt für kfz-bewertung als angenommen, `externeId` wird in `nachrichten` gespeichert.

Fehler, immer dieselbe Form:

```json
{ "ok": false, "code": "EMPFAENGER_GESPERRT", "text": "…", "wiederholbar": false }
```

| HTTP | `code` | wiederholbar | Bedeutung |
|---|---|---|---|
| 400 | `ANFRAGE_UNGUELTIG` | nein | Body/Feld verletzt das Schema |
| 401 | `SIGNATUR_UNGUELTIG`, `ZEITSTEMPEL_ABGELAUFEN` | nein | Auth |
| 403 | `EMPFAENGER_GESPERRT` | nein | Nummer gesperrt/abgemeldet, Manager-Regel verbietet |
| 409 | `KORRELATION_KONFLIKT` | nein | gleiche `korrelation`, anderer Inhalt |
| 429 | `FLUTSCHUTZ` | ja | Manager-Rate erreicht; `Retry-After` in Sekunden |
| 502 | `WHATSAPP_NICHT_ERREICHBAR` | ja | Sitzung/Zugang des Managers gestört |
| 503 | `MCP_ZUGANG_AUS`, `MANAGER_BUSY` | ja | Manager aktuell nicht bereit |

## Verhalten im ManagerKanal

- Jede Abweichung wird `AppFehler("VERSAND_FEHLGESCHLAGEN")` (Katalog vorhanden); `code` des Managers kommt als Kontext, nie der Text/die Nummer.
- Zeitlimit und Wiederholungen (Anzahl, Abstand) aus der Registry (`versand.manager.*`, neu anzulegen mit dem Adapter), nicht im Code. Wiederholt wird nur bei `wiederholbar: true`, mit **derselben** `korrelation`.
- `kanalFuerKontakt`: Kontakt mit `@` → E-Mail, Kontakt `+`/Ziffern → `ManagerKanal`, sonst `null`; fehlt `MANAGER_VERSAND_URL`, `null` (an Mensch), nicht raten.
- Not-Aus `ablauf.autopilot` und Freigabeprüfung liegen vor dem Kanal und gelten unverändert.

## Geheimnisnamen

Stehen in `apps/api/.dev.vars.example`; Werte verteilt der Business Manager, nie von Hand.

| Name | Art |
|---|---|
| `MANAGER_VERSAND_URL` | Standort-Variable (Basis-URL des Managers) |
| `MANAGER_VERSAND_HMAC_SCHLUESSEL` | Geheimnis (HMAC, kfz-bewertung → Manager) |

## Offen für den Manager-Teil (Sperrbereich whatsapp-manager)

Endpunkt `/kfz/versand` mit obigem Vertrag, Geheimnis `MANAGER_VERSAND_HMAC_SCHLUESSEL` in der Registry, Idempotenzspeicher je `korrelation`.
