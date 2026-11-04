import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import type { AppFehler } from "../src/fehler/app-fehler.js";
import { ManagerKanal, sende } from "../src/versand/index.js";

const einst = () => new Einstellungen(env.DB, async () => {});
const SCHLUESSEL = "attrappe-schluessel";
const JETZT = 1_700_000_000;
const werte = { name: "Anna", fahrzeug: "VW Golf", ankaufVon: "10.000 €", ankaufBis: "11.000 €", gueltigBis: "01.07.", fehlend: "Kilometer" };

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')")
    .bind(schluessel, JSON.stringify(wert))
    .run();
}
async function anfrage(id: string, status: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'admin', ?2, '{}')").bind(id, status).run();
}
const fehlerCode = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppFehler | null)?.code;
const nachrichten = async () => (await env.DB.prepare("SELECT * FROM nachrichten ORDER BY erstellt_am").all<Record<string, unknown>>()).results;
const ereignisse = async () => (await env.DB.prepare("SELECT * FROM anfrage_ereignisse ORDER BY id").all<Record<string, unknown>>()).results;

async function hmac(text: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(SCHLUESSEL), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Manager nach docs/manager-versand.md: prüft Signatur und Zeitstempel, idempotent je Korrelation. */
function attrappe(vorgabe: Array<{ status: number; body: unknown }> = [], hmacSchluessel = SCHLUESSEL) {
  const aufrufe: Array<{ korrelation: string }> = [];
  const bekannt = new Map<string, string>();
  const fetchAttrappe = (async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    const body = String(init.body);
    const zeit = h.get("x-kfz-zeitstempel") ?? "";
    const antwort = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (h.get("x-kfz-signatur") !== `sha256=${await hmac(`${zeit}.${body}`)}` || zeit !== String(JETZT)) {
      return antwort(403, { ok: false, code: "SIGNATUR_UNGUELTIG", wiederholbar: false });
    }
    const korrelation = (JSON.parse(body) as { korrelation: string }).korrelation;
    aufrufe.push({ korrelation });
    const naechste = vorgabe.shift();
    if (naechste) return antwort(naechste.status, naechste.body);
    const id = bekannt.get(korrelation) ?? `wamid.${bekannt.size + 1}`;
    bekannt.set(korrelation, id);
    return antwort(200, { ok: true, externeId: id, zustand: "gesendet" });
  }) as unknown as typeof fetch;
  const kanal = new ManagerKanal(
    { url: "https://manager.test", hmacSchluessel },
    { zeitlimitMs: 1000, wiederholungen: 1, abstandMs: 0, abstandMaxMs: 0 },
    { fetch: fetchAttrappe, jetztSekunden: () => JETZT, warte: async () => {} },
  );
  return { aufrufe, kanal };
}
const auftrag = (kanal: ManagerKanal, anlass: string, extra = {}) => ({ kanal, an: "+49 170 1234567", anlass, werte, korrelation: "k1", ...extra });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen;");
});

describe("Versand über die Manager-Attrappe", () => {
  it("Not-Aus aus: nichts an die Attrappe, Nachricht geparkt", async () => {
    await setze("ablauf.autopilot", "aus");
    const m = attrappe();
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(m.kanal, "eingang")))).toBe("AUTOPILOT_GESPERRT");
    expect(m.aufrufe).toHaveLength(0);
    expect((await nachrichten())[0]).toMatchObject({ status: "geparkt", autopilot: "aus" });
  });

  it("Anlass mit Preis ohne Freigabe: FREIGABE_FEHLT, kein Aufruf", async () => {
    await anfrage("a1", "zur_freigabe");
    const m = attrappe();
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(m.kanal, "angebot", { anfrageId: "a1" })))).toBe("FREIGABE_FEHLT");
    expect(m.aufrufe).toHaveLength(0);
    expect(await nachrichten()).toHaveLength(0);
  });

  it("Erfolg: Zeile mit externeId und Zustand, Ereignis ohne Statuswechsel, ohne Text oder Nummer", async () => {
    await anfrage("a1", "eingegangen");
    const m = attrappe();
    const r = await sende(env.DB, einst(), auftrag(m.kanal, "eingang", { anfrageId: "a1" }));
    expect(r.status).toBe("gesendet");
    expect((await nachrichten())[0]).toMatchObject({ status: "gesendet", kanal: "whatsapp", externe_id: "wamid.1", zustand: "gesendet", anfrage_id: "a1" });
    const [e] = await ereignisse();
    expect(e).toMatchObject({ anfrage_id: "a1", aktion: "nachricht_gesendet", status_von: "eingegangen", status_nach: "eingegangen", durch: "system", notiz: "eingang/whatsapp", korrelation: "k1" });
    expect(JSON.stringify(e)).not.toContain("1234567");
    expect(JSON.stringify(e)).not.toContain("Anna");
  });

  it("eingereiht wird als Zustand gespeichert", async () => {
    const m = attrappe([{ status: 200, body: { ok: true, externeId: "wamid.9", zustand: "eingereiht" } }]);
    await sende(env.DB, einst(), auftrag(m.kanal, "eingang"));
    expect((await nachrichten())[0]).toMatchObject({ status: "gesendet", zustand: "eingereiht", externe_id: "wamid.9" });
    expect(await ereignisse()).toHaveLength(0);
  });

  it("wiederholt mit derselben Korrelation; die Attrappe bleibt idempotent", async () => {
    const m = attrappe([{ status: 503, body: { ok: false, code: "MANAGER_BUSY", wiederholbar: true } }]);
    await sende(env.DB, einst(), auftrag(m.kanal, "eingang"));
    expect(m.aufrufe.map((a) => a.korrelation)).toEqual(["k1", "k1"]);
    expect(await nachrichten()).toHaveLength(1);
  });

  it.each([
    [403, "SIGNATUR_UNGUELTIG"],
    [409, "KORRELATION_KONFLIKT"],
    [429, "FLUTSCHUTZ"],
    [502, "WHATSAPP_NICHT_ERREICHBAR"],
    [503, "MANAGER_BUSY"],
  ])("Fehler %i %s: fehlgeschlagen und VERSAND_FEHLGESCHLAGEN, kein Ereignis", async (status, code) => {
    await anfrage("a1", "eingegangen");
    const m = attrappe([{ status, body: { ok: false, code, wiederholbar: false } }]);
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(m.kanal, "eingang", { anfrageId: "a1" })))).toBe("VERSAND_FEHLGESCHLAGEN");
    expect((await nachrichten())[0]).toMatchObject({ status: "fehlgeschlagen", fehler_code: "VERSAND_FEHLGESCHLAGEN", zustand: null });
    expect(await ereignisse()).toHaveLength(0);
  });

  it("falsche Signatur: die Attrappe antwortet 403, nichts wird gesendet", async () => {
    const m = attrappe([], "anderer-schluessel");
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(m.kanal, "eingang")))).toBe("VERSAND_FEHLGESCHLAGEN");
    expect(m.aufrufe).toHaveLength(0);
  });
});
