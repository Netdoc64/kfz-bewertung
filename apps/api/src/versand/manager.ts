import { AppFehler } from "../fehler/app-fehler.js";
import type { AusgehendeNachricht, Kanal } from "./kanal.js";

/** Zugang zum Business Manager (Standort-Variable und Geheimnis; Werte verteilt der Manager). */
export interface ManagerZugang {
  url: string;
  hmacSchluessel: string;
}

/** Aus der Registry (`versand.manager.*`). */
export interface ManagerRegeln {
  zeitlimitMs: number;
  wiederholungen: number;
  abstandMs: number;
  abstandMaxMs: number;
}

export interface ManagerAbhaengigkeiten {
  fetch?: typeof fetch;
  /** Unix-Sekunden, UTC. */
  jetztSekunden?: () => number;
  warte?: (ms: number) => Promise<void>;
}

const ENDPUNKT = "/kfz/versand";
const E164 = /^\+[1-9]\d{6,14}$/;

/** Macht aus einer eingetippten Nummer E.164 (Trennzeichen raus, 00 → +); sonst null. */
export function alsE164(kontakt: string): string | null {
  const roh = kontakt.replace(/[\s()./-]/g, "");
  const nummer = roh.startsWith("00") ? `+${roh.slice(2)}` : roh;
  return E164.test(nummer) ? nummer : null;
}

async function signiere(schluessel: string, zeitstempel: string, koerper: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(schluessel), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${zeitstempel}.${koerper}`)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface ManagerAntwort {
  ok?: boolean;
  externeId?: string;
  zustand?: string;
  code?: string;
  wiederholbar?: boolean;
}

/** WhatsApp über den Business Manager (docs/manager-versand.md). Wiederholt nur bei `wiederholbar: true`, mit derselben Korrelation. */
export class ManagerKanal implements Kanal {
  readonly name = "whatsapp";

  constructor(
    private readonly zugang: ManagerZugang,
    private readonly regeln: ManagerRegeln,
    private readonly dep: ManagerAbhaengigkeiten = {},
  ) {}

  async sende(n: AusgehendeNachricht): Promise<{ externeId?: string }> {
    const an = alsE164(n.an);
    if (!an) throw new AppFehler("VERSAND_FEHLGESCHLAGEN", "Empfänger keine gültige Nummer", { kontext: { grund: "nummer_ungueltig" } });
    const koerper = JSON.stringify({ kanal: "whatsapp", an, text: n.text, korrelation: n.korrelation });
    const warte = this.dep.warte ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let versuch = 0; ; versuch++) {
      const ergebnis = await this.einmal(koerper);
      if (ergebnis.ok) return ergebnis.antwort;
      if (!ergebnis.wiederholbar || versuch >= this.regeln.wiederholungen) {
        throw new AppFehler("VERSAND_FEHLGESCHLAGEN", "Manager hat den Versand nicht angenommen", {
          kontext: { managerCode: ergebnis.code, http: ergebnis.http, versuche: versuch + 1 },
        });
      }
      await warte(Math.min(Math.max(ergebnis.warteMs ?? 0, this.regeln.abstandMs), this.regeln.abstandMaxMs));
    }
  }

  private async einmal(koerper: string): Promise<
    | { ok: true; antwort: { externeId?: string } }
    | { ok: false; code: string; http: number; wiederholbar: boolean; warteMs?: number }
  > {
    const zeitstempel = String((this.dep.jetztSekunden ?? (() => Math.floor(Date.now() / 1000)))());
    const signatur = await signiere(this.zugang.hmacSchluessel, zeitstempel, koerper);
    let res: Response;
    try {
      res = await (this.dep.fetch ?? fetch)(`${this.zugang.url.replace(/\/+$/, "")}${ENDPUNKT}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kfz-zeitstempel": zeitstempel, "x-kfz-signatur": signatur },
        body: koerper,
        signal: AbortSignal.timeout(this.regeln.zeitlimitMs),
      });
    } catch (e) {
      // Netzwerkfehler und Zeitlimit: der Manager hat womöglich angenommen; Wiederholung ist über die Korrelation idempotent.
      const grund = e instanceof Error && e.name === "TimeoutError" ? "zeitlimit" : "netzwerk";
      return { ok: false, code: grund, http: 0, wiederholbar: true };
    }

    let json: ManagerAntwort | null = null;
    try {
      json = (await res.json()) as ManagerAntwort;
    } catch {
      json = null;
    }
    if (res.ok && json?.ok === true) return { ok: true, antwort: json.externeId ? { externeId: json.externeId } : {} };
    if (res.ok) return { ok: false, code: "antwort_unlesbar", http: res.status, wiederholbar: false };

    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      code: typeof json?.code === "string" ? json.code : "unbekannt",
      http: res.status,
      // Ohne lesbare Fehlerform entscheidet nur ein Serverfehler über Wiederholung.
      wiederholbar: json?.wiederholbar === true || (json === null && res.status >= 500),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { warteMs: retryAfter * 1000 } : {}),
    };
  }
}
