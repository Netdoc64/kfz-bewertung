import { AppFehler } from "../fehler/app-fehler.js";
import type { PushAnschluss } from "./port.js";

const FCM_BASIS = "https://fcm.googleapis.com/v1/projects";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URI_STANDARD = "https://oauth2.googleapis.com/token";

interface Dienstkonto {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmZugang {
  /** Firebase-Projektkennung (Standort-Variable PUSH_FCM_PROJEKT). */
  projekt: string;
  /** JSON des Dienstkonto-Schlüssels (PUSH_FCM_DIENSTKONTO). */
  dienstkonto: string;
}

const b64url = (b: ArrayBuffer | string): string => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pem(p: string): ArrayBuffer {
  const roh = atob(p.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
  return Uint8Array.from(roh, (c) => c.charCodeAt(0)).buffer;
}

function fehler(nachricht: string, ursache?: unknown): AppFehler {
  return new AppFehler("PUSH_FEHLGESCHLAGEN", nachricht, { ursache });
}

/** FCM HTTP v1 mit OAuth-Token aus dem Dienstkonto. Das Zugriffstoken wird bis kurz vor Ablauf wiederverwendet. */
export function fcmAnschluss(zugang: FcmZugang, abruf: typeof fetch = fetch, jetzt: () => number = Date.now): PushAnschluss {
  let zugriff: { token: string; bis: number } | undefined;

  async function zugriffsToken(): Promise<string> {
    if (zugriff && zugriff.bis > jetzt() + 60_000) return zugriff.token;
    let konto: Dienstkonto;
    try {
      konto = JSON.parse(zugang.dienstkonto) as Dienstkonto;
    } catch (e) {
      throw fehler("Dienstkonto ist kein gültiges JSON", e);
    }
    const uri = konto.token_uri ?? TOKEN_URI_STANDARD;
    const sek = Math.floor(jetzt() / 1000);
    const kopf = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const nutzlast = b64url(JSON.stringify({ iss: konto.client_email, scope: SCOPE, aud: uri, iat: sek, exp: sek + 3600 }));
    let signatur: ArrayBuffer;
    try {
      const schluessel = await crypto.subtle.importKey("pkcs8", pem(konto.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      signatur = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", schluessel, new TextEncoder().encode(`${kopf}.${nutzlast}`));
    } catch (e) {
      throw fehler("Signieren mit dem Dienstkonto fehlgeschlagen", e);
    }
    const antwort = await abruf(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${kopf}.${nutzlast}.${b64url(signatur)}` }),
    });
    if (!antwort.ok) throw fehler(`FCM-Anmeldung abgelehnt (HTTP ${antwort.status})`);
    const j = (await antwort.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!j?.access_token) throw fehler("FCM-Anmeldung ohne Zugriffstoken");
    zugriff = { token: j.access_token, bis: jetzt() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  return {
    async sende(geraetePushToken, titel, text) {
      try {
        const token = await zugriffsToken();
        const antwort = await abruf(`${FCM_BASIS}/${encodeURIComponent(zugang.projekt)}/messages:send`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ message: { token: geraetePushToken, notification: { title: titel, body: text } } }),
        });
        if (!antwort.ok) {
          if (antwort.status === 401) zugriff = undefined;
          throw fehler(`FCM lehnte die Nachricht ab (HTTP ${antwort.status})`);
        }
      } catch (e) {
        throw e instanceof AppFehler ? e : fehler("FCM nicht erreichbar", e);
      }
    },
  };
}
