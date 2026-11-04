import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index.js";

// Nur Testkonfiguration, keine echten Schlüssel.
const SCHLUESSEL = "test-webhook-schluessel";
const umgebung = () =>
  ({
    ...env,
    WEBHOOK_HMAC_SCHLUESSEL: SCHLUESSEL,
    MANAGER_VERSAND_URL: "https://manager.test",
    MANAGER_VERSAND_HMAC_SCHLUESSEL: "attrappe-schluessel",
    BEWERTUNG_QUEUE: { send: async () => {} },
  }) as unknown as typeof env;

async function signatur(zeitstempel: string, koerper: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(SCHLUESSEL), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${zeitstempel}.${koerper}`)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function poste(nutzlast: unknown) {
  const koerper = JSON.stringify(nutzlast);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.request(
    "http://lokal/webhook/whatsapp",
    { method: "POST", headers: { "content-type": "application/json", "X-Kfz-Zeitstempel": ts, "X-Kfz-Signatur": await signatur(ts, koerper) }, body: koerper },
    umgebung(),
  );
}

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

const A = "+491701234567";
const B = "+491709999999";
let nr = 0;
const unklar = (von: string) => ({ nachrichtId: `wamid.u${++nr}`, von, text: "Hallo, was zahlt ihr für mein Auto?" });
const klar = (von: string, modell: string) => ({ nachrichtId: `wamid.k${++nr}`, von, text: `Ich verkaufe meinen BMW ${modell}, 120.000 km, EZ 03/2018` });

const geparkt = async (von: string) => (await env.DB.prepare("SELECT kanal, grund FROM eingang_geparkt WHERE kontakt = ?1").bind(von).all<{ kanal: string; grund: string }>()).results;
const fehler = async (code: string) => (await env.DB.prepare("SELECT ort FROM fehler_ereignisse WHERE code = ?1").bind(code).all<{ ort: string }>()).results;
const anfragenAnzahl = async (von: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM anfragen WHERE kunde_kontakt = ?1").bind(von).first<{ n: number }>())!.n;

let managerAufrufe: string[];

beforeEach(async () => {
  nr = 0;
  managerAufrufe = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    managerAufrufe.push(String((JSON.parse(String(init.body)) as { an?: string }).an ?? url));
    return new Response(JSON.stringify({ ok: true, externeId: `wamid.out${managerAufrufe.length}`, zustand: "gesendet" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await env.DB.exec(
    "DELETE FROM ratenzaehler; DELETE FROM fehler_ereignisse; DELETE FROM whatsapp_eingang; DELETE FROM email_anhaenge; DELETE FROM email_eingang; DELETE FROM eingang_geparkt; DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen;",
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp-Flutschutz je Absender (A9)", () => {
  it("Rohgrenze: n+1. Nachricht derselben Nummer wird verworfen, ohne Antwort, mit Eintrag im Fehlerspeicher", async () => {
    await setze("ratenlimit.whatsapp.max", 2);
    for (let i = 0; i < 2; i++) expect(await (await poste(unklar(A))).json()).toMatchObject({ ergebnis: "verarbeitet" });
    const aufrufeVorher = managerAufrufe.length;
    const r = await poste(unklar(A));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, ergebnis: "verworfen" });
    expect(managerAufrufe).toHaveLength(aufrufeVorher);
    expect(await geparkt(A)).toHaveLength(2);
    expect(await fehler("RATE_LIMIT_UEBERSCHRITTEN")).toEqual([{ ort: "whatsapp:ratenlimit" }]);
    // verworfen heißt: nicht einmal als „gesehen“ vermerkt
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM whatsapp_eingang").first<{ n: number }>())!.n).toBe(2);
  });

  it("andere Nummer bleibt unberührt, die Zählung läuft über die Nummer, nicht über die IP", async () => {
    await setze("ratenlimit.whatsapp.max", 1);
    await poste(unklar(A));
    expect(await (await poste(unklar(A))).json()).toMatchObject({ ergebnis: "verworfen" });
    expect(await (await poste(unklar(B))).json()).toMatchObject({ ergebnis: "verarbeitet" });
    expect(await geparkt(B)).toHaveLength(1);
    const roh = (await env.DB.prepare("SELECT absender_hash FROM ratenzaehler WHERE kanal = 'whatsapp'").all<{ absender_hash: string }>()).results;
    expect(roh).toHaveLength(2);
    expect(JSON.stringify(roh)).not.toContain("1701234567");
  });

  it("Rückfragen an die Nummer sind begrenzt: nach der Grenze geht nichts mehr an den Manager", async () => {
    await setze("ratenlimit.whatsapp.max", 2);
    for (let i = 0; i < 5; i++) await poste(unklar(A));
    expect(managerAufrufe).toEqual([A, A]);
  });

  it("Tageslimit eingang.maxJeAbsenderUndTag: Eingang geparkt mit Kanal whatsapp und Grund flutschutz, ZU_VIELE_ANFRAGEN gemeldet, keine Nachricht an den Manager", async () => {
    await setze("eingang.maxJeAbsenderUndTag", 2);
    for (const modell of ["320d", "118d"]) {
      expect(await (await poste(klar(A, modell))).json()).toMatchObject({ ergebnis: "verarbeitet" });
      // Anfrage abschließen, damit die nächste Nachricht nicht an sie angehängt wird (A8)
      await env.DB.prepare("UPDATE anfragen SET status = 'abgelehnt' WHERE kunde_kontakt = ?1").bind(A).run();
    }
    const aufrufeVorher = managerAufrufe.length;
    expect(await (await poste(klar(A, "520d"))).json()).toMatchObject({ ergebnis: "verarbeitet" });
    expect(await anfragenAnzahl(A)).toBe(2);
    expect(await geparkt(A)).toEqual([{ kanal: "whatsapp", grund: "flutschutz" }]);
    expect((await fehler("ZU_VIELE_ANFRAGEN")).map((f) => f.ort)).toEqual(["anfragen:flutschutz"]);
    expect(managerAufrufe).toHaveLength(aufrufeVorher);
    // andere Nummer ist nicht betroffen
    await poste(klar(B, "320d"));
    expect(await anfragenAnzahl(B)).toBe(1);
  });

  it("Grenzwerte kommen nur aus der Registry: Änderung wirkt ohne Codeänderung", async () => {
    // Standard: 30 je Stunde, also werden 3 Nachrichten nicht verworfen
    for (let i = 0; i < 3; i++) expect(await (await poste(unklar(A))).json()).toMatchObject({ ergebnis: "verarbeitet" });
    await setze("ratenlimit.whatsapp.max", 3);
    expect(await (await poste(unklar(A))).json()).toMatchObject({ ergebnis: "verworfen" });
  });
});
