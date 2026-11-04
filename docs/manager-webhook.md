# Webhook Business Manager → kfz-bewertung (WhatsApp-Eingang)

Gegenstück zu [manager-versand.md](manager-versand.md). Der Manager empfängt WhatsApp und
reicht jede Kundennachricht an kfz-bewertung weiter. Jede Richtung hat **ihren eigenen** Schlüssel:
dieser Eingang nutzt `WEBHOOK_HMAC_SCHLUESSEL`, der Versand `MANAGER_VERSAND_HMAC_SCHLUESSEL`.

## Endpunkt

`POST {kfz-bewertung}/webhook/whatsapp` — Body `application/json`, UTF-8. Die Route liegt bewusst
außerhalb von `/api/*`: Bilder kommen base64 im Body, deshalb gilt die eigene Grenze
`webhook.manager.bodyMaxBytes` (Registry) statt `sicherheit.bodyMaxBytes`; darüber `413 ANFRAGE_ZU_GROSS`.

```json
{
  "nachrichtId": "wamid.HBgM…",
  "von": "+491701234567",
  "name": "Max Mustermann",
  "text": "Ich verkaufe meinen BMW 320d, 120.000 km",
  "bilder": [{ "medientyp": "image/jpeg", "daten": "<base64>", "dateiname": "schein.jpg" }]
}
```

| Feld | Regel |
|---|---|
| `nachrichtId` | 1–200 Zeichen; **Wiederholschutz**: dieselbe ID wird nie ein zweites Mal verarbeitet |
| `von` | Absender, E.164 mit führendem `+` |
| `name` | optional, WhatsApp-Profilname; fehlt er, gilt die Nummer |
| `text` | optional; zitierte Antworten gibt es bei WhatsApp nicht, der Text zählt vollständig |
| `bilder` | optional; höchstens 50 im Body, gespeichert werden nur so viele und solche, wie `mail.anhangMaxAnzahl`, `mail.anhangMaxBytes`, `mail.anhangTypen` erlauben (wie E-Mail-Anhänge); der Rest wird verworfen und protokolliert |

## Auth: HMAC + Zeitstempel

| Kopfzeile | Inhalt |
|---|---|
| `X-Kfz-Zeitstempel` | Unix-Sekunden, UTC |
| `X-Kfz-Signatur` | `sha256=` + Hex von HMAC-SHA256 |

Signiert wird `"{zeitstempel}.{rohkörper}"` (Rohbytes des Bodys, wie gesendet) mit
`WEBHOOK_HMAC_SCHLUESSEL`. kfz-bewertung prüft:

1. Schlüssel gesetzt, sonst `503 WEBHOOK_NICHT_KONFIGURIERT` — nie wird ohne Schlüssel geraten.
2. Kopfzeilen vorhanden und wohlgeformt, Signatur konstantzeitig gleich, sonst `401 SIGNATUR_UNGUELTIG`.
3. Zeitstempel höchstens `webhook.manager.toleranzSekunden` (Registry, Standard 300 s) von der eigenen Uhr entfernt — in beide Richtungen —, sonst `401 ZEITSTEMPEL_ABGELAUFEN`.
4. Nutzlast gültig, sonst `400 EINGABE_UNGUELTIG`.

Wiederholen darf der Manager mit **neuem** Zeitstempel und neuer Signatur, aber **gleicher** `nachrichtId`; das ist sicher.

## Antwort

Erfolg `200`:

```json
{ "ok": true, "ergebnis": "verarbeitet" }
```

`ergebnis`: `verarbeitet`, `doppelt` (die `nachrichtId` war schon bekannt, nichts geschehen) oder `verworfen` (Flutschutz: die Nummer
hat `ratenlimit.whatsapp.max` je Fenster überschritten; nichts gespeichert, keine Antwort an den Kunden). Beides gilt
für den Manager als zugestellt. Fehler im einheitlichen Fehlerformat von kfz-bewertung
(`{ "fehler": { "code", "text", "korrelationsId", "wiederholbar" } }`); der Manager wiederholt nur bei `wiederholbar: true`.

## Verarbeitung

- **Bezug (A8):** Hat die Nummer eine noch offene Anfrage, hängt die Nachricht daran. Sonst:
- **Fahrzeug:** regelbasiert wie bei E-Mail (`mail.marken`, `mail.modellStoppwoerter`), ohne KI; nur sicher Erkanntes zählt.
- **Klar** (Marke und Modell): neue Anfrage mit Kanal `whatsapp`.
- **Unklar:** Nachricht wird geparkt (`eingang_geparkt`, Grund `whatsapp_unklar`) und höchstens einmal je Tageslimit (`eingang.maxJeAbsenderUndTag`) mit der Vorlage `rueckfrage` nachgefragt.
- **Antworten** gehen nur über die Versand-Pipeline an den Manager: Not-Aus `ablauf.autopilot` wird bei jedem Versand geprüft, Nachrichten mit Preis nur nach Admin-Freigabe. Die KI bestimmt nie den Preis.
