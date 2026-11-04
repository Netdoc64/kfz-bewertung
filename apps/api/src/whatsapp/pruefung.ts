import { AppFehler } from "../fehler/app-fehler.js";

export interface WebhookPruefung {
  /** Fehlt der Schlüssel, wird abgewiesen — nie geraten. */
  schluessel: string | undefined;
  zeitstempel: string | null | undefined;
  signatur: string | null | undefined;
  koerper: ArrayBuffer;
  toleranzSekunden: number;
  /** Unix-Sekunden, UTC. */
  jetztSekunden?: number;
}

/**
 * Prüft Signatur und Zeitstempel eines Webhooks vom Manager (docs/manager-webhook.md).
 * Signiert ist `"{zeitstempel}.{rohkörper}"` mit HMAC-SHA256. Der Vergleich läuft über
 * `crypto.subtle.verify` und ist damit konstantzeitig; erst danach wird der Zeitstempel gewertet.
 */
export async function pruefeWebhook(p: WebhookPruefung): Promise<void> {
  if (!p.schluessel) throw new AppFehler("WEBHOOK_NICHT_KONFIGURIERT", "WEBHOOK_HMAC_SCHLUESSEL fehlt");
  const ts = p.zeitstempel ?? "";
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(p.signatur ?? "")?.[1];
  if (!/^\d{1,12}$/.test(ts) || !hex) throw new AppFehler("SIGNATUR_UNGUELTIG", "Kopfzeilen fehlen oder sind fehlerhaft");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(p.schluessel), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
  const daten = new Uint8Array([...enc.encode(`${ts}.`), ...new Uint8Array(p.koerper)]);
  if (!(await crypto.subtle.verify("HMAC", key, mac, daten))) throw new AppFehler("SIGNATUR_UNGUELTIG");

  const jetzt = p.jetztSekunden ?? Math.floor(Date.now() / 1000);
  const abweichung = Math.abs(jetzt - Number(ts));
  if (abweichung > p.toleranzSekunden) throw new AppFehler("ZEITSTEMPEL_ABGELAUFEN", undefined, { kontext: { abweichungSekunden: abweichung } });
}
