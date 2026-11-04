import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";
import { pruefeWebhook } from "../src/whatsapp/index.js";

// Nur Testkonfiguration, kein echter Schlüssel.
const TEST_SCHLUESSEL = "test-webhook-schluessel";
const umgebung = (schluessel: string | null = TEST_SCHLUESSEL) =>
  ({
    ...env,
    ...(schluessel ? { WEBHOOK_HMAC_SCHLUESSEL: schluessel } : {}),
    BEWERTUNG_QUEUE: { send: async () => {} },
  }) as unknown as typeof env;

async function signatur(schluessel: string, zeitstempel: string, koerper: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(schluessel), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${zeitstempel}.${koerper}`)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const jetzt = () => Math.floor(Date.now() / 1000);

interface Optionen {
  zeitstempel?: number;
  schluessel?: string;
  signatur?: string;
  ohneKopf?: boolean;
  umgebungSchluessel?: string | null;
}
async function poste(nutzlast: unknown, o: Optionen = {}) {
  const koerper = typeof nutzlast === "string" ? nutzlast : JSON.stringify(nutzlast);
  const ts = String(o.zeitstempel ?? jetzt());
  const kopf: Record<string, string> = { "content-type": "application/json" };
  if (!o.ohneKopf) {
    kopf["X-Kfz-Zeitstempel"] = ts;
    kopf["X-Kfz-Signatur"] = o.signatur ?? (await signatur(o.schluessel ?? TEST_SCHLUESSEL, ts, koerper));
  }
  return app.request("http://lokal/webhook/whatsapp", { method: "POST", headers: kopf, body: koerper }, "umgebungSchluessel" in o ? umgebung(o.umgebungSchluessel) : umgebung());
}

const klar = { nachrichtId: "wamid.1", von: "+491701234567", name: "Kunde", text: "Ich verkaufe meinen BMW 320d, 120.000 km, EZ 03/2018" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const anfragen = () => env.DB.prepare("SELECT * FROM anfragen").all<{ id: string; kanal: string; kunde_kontakt: string; fahrzeug: string }>();
const geparkt = () => env.DB.prepare("SELECT * FROM eingang_geparkt").all<{ id: string; kanal: string; grund: string; kontakt: string }>();

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM ratenzaehler; DELETE FROM whatsapp_eingang; DELETE FROM email_anhaenge; DELETE FROM email_eingang; DELETE FROM eingang_geparkt; DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen;",
  );
});

describe("WhatsApp-Webhook: Signatur und Zeitstempel", () => {
  it("gültige Signatur legt eine Anfrage mit Kanal whatsapp an", async () => {
    const r = await poste(klar);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, ergebnis: "verarbeitet" });
    const a = (await anfragen()).results;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kanal: "whatsapp", kunde_kontakt: "+491701234567" });
    expect(JSON.parse(a[0]!.fahrzeug)).toMatchObject({ marke: "BMW", modell: "320d", kilometer: 120000 });
  });

  it("falsche Signatur → 401 SIGNATUR_UNGUELTIG, nichts angelegt", async () => {
    const r = await poste(klar, { schluessel: "anderer-schluessel" });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { fehler: { code: string } }).fehler.code).toBe("SIGNATUR_UNGUELTIG");
    expect((await anfragen()).results).toHaveLength(0);
  });

  it("veränderter Körper bei gültiger Signatur des Originals → 401", async () => {
    const original = JSON.stringify(klar);
    const ts = String(jetzt());
    const r = await poste(original.replace("BMW", "Audi"), { zeitstempel: Number(ts), signatur: await signatur(TEST_SCHLUESSEL, ts, original) });
    expect(r.status).toBe(401);
  });

  it.each([
    ["fehlende Kopfzeilen", { ohneKopf: true }],
    ["Signatur ohne Präfix", { signatur: "abcd" }],
  ])("%s → 401 SIGNATUR_UNGUELTIG", async (_n, o) => {
    const r = await poste(klar, o);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { fehler: { code: string } }).fehler.code).toBe("SIGNATUR_UNGUELTIG");
  });

  it.each([
    ["alter", -3600],
    ["zukünftiger", 3600],
  ])("%s Zeitstempel (richtig signiert) → 401 ZEITSTEMPEL_ABGELAUFEN", async (_n, versatz) => {
    const r = await poste(klar, { zeitstempel: jetzt() + versatz });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { fehler: { code: string } }).fehler.code).toBe("ZEITSTEMPEL_ABGELAUFEN");
    expect((await anfragen()).results).toHaveLength(0);
  });

  it("Toleranz kommt aus der Registry", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('webhook.manager.toleranzSekunden', '7200', 1, 'test')").run();
    expect((await poste(klar, { zeitstempel: jetzt() - 3600 })).status).toBe(200);
  });

  it("fehlender Schlüssel → 503 WEBHOOK_NICHT_KONFIGURIERT, auch bei „passender“ Signatur mit leerem Schlüssel", async () => {
    for (const o of [{ umgebungSchluessel: null }, { umgebungSchluessel: "", signatur: `sha256=${"0".repeat(64)}` }]) {
      const r = await poste(klar, o);
      expect(r.status).toBe(503);
      expect(((await r.json()) as { fehler: { code: string } }).fehler.code).toBe("WEBHOOK_NICHT_KONFIGURIERT");
    }
    expect((await anfragen()).results).toHaveLength(0);
  });

  it("pruefeWebhook ist rein: akzeptiert Toleranzgrenze, weist eine Sekunde darüber ab", async () => {
    const koerper = new TextEncoder().encode("{}");
    const ts = "1700000000";
    const sig = await signatur(TEST_SCHLUESSEL, ts, "{}");
    const basis = { schluessel: TEST_SCHLUESSEL, zeitstempel: ts, signatur: sig, koerper: koerper.buffer as ArrayBuffer, toleranzSekunden: 300 };
    await expect(pruefeWebhook({ ...basis, jetztSekunden: 1_700_000_300 })).resolves.toBeUndefined();
    await expect(pruefeWebhook({ ...basis, jetztSekunden: 1_700_000_301 })).rejects.toMatchObject({ code: "ZEITSTEMPEL_ABGELAUFEN" });
  });
});

describe("WhatsApp-Webhook: Verarbeitung", () => {
  it("dieselbe Nachrichten-ID wird kein zweites Mal verarbeitet", async () => {
    expect(await (await poste(klar)).json()).toMatchObject({ ergebnis: "verarbeitet" });
    expect(await (await poste(klar)).json()).toEqual({ ok: true, ergebnis: "doppelt" });
    expect((await anfragen()).results).toHaveLength(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM anfrage_nachrichten").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("weitere Nachricht derselben Nummer hängt an die offene Anfrage (A8)", async () => {
    await poste(klar);
    const r = await poste({ nachrichtId: "wamid.2", von: klar.von, text: "Kilometerstand ist 125.000 km" });
    expect(r.status).toBe(200);
    expect((await anfragen()).results).toHaveLength(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM anfrage_nachrichten").first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it("unklares Fahrzeug wird geparkt, ohne Manager-Zugang keine Antwort", async () => {
    const r = await poste({ nachrichtId: "wamid.3", von: "+491709999999", text: "Hallo, was zahlt ihr für mein Auto?" });
    expect(r.status).toBe(200);
    expect((await anfragen()).results).toHaveLength(0);
    expect((await geparkt()).results).toMatchObject([{ kanal: "whatsapp", grund: "whatsapp_unklar", kontakt: "+491709999999" }]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM nachrichten").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("Bild wird in R2 gespeichert und der Anfrage zugeordnet; unerlaubter Typ wird verworfen", async () => {
    const b64 = btoa(String.fromCharCode(...JPEG));
    const r = await poste({
      ...klar,
      bilder: [
        { medientyp: "image/jpeg", daten: b64, dateiname: "schein.jpg" },
        { medientyp: "application/x-msdownload", daten: b64 },
        { medientyp: "image/png", daten: "%%%kein-base64%%%" },
      ],
    });
    expect(r.status).toBe(200);
    const z = (await env.DB.prepare("SELECT * FROM email_anhaenge").all<{ anfrage_id: string; r2_schluessel: string; medientyp: string; groesse: number; dateiname: string }>()).results;
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ medientyp: "image/jpeg", groesse: JPEG.byteLength, dateiname: "schein.jpg" });
    expect(z[0]!.anfrage_id).toBe((await anfragen()).results[0]!.id);
    const obj = await env.BERICHTE.get(z[0]!.r2_schluessel);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(JPEG);
  });

  it("ungültige Nutzlast (richtig signiert) → 400 EINGABE_UNGUELTIG", async () => {
    for (const k of [{ nachrichtId: "x", von: "0170123" }, "kein json"]) {
      const r = await poste(k);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { fehler: { code: string } }).fehler.code).toBe("EINGABE_UNGUELTIG");
    }
  });

  it("zu großer Körper → 413 vor jeder Prüfung", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('webhook.manager.bodyMaxBytes', '2048', 1, 'test')").run();
    const r = await poste({ ...klar, text: "x".repeat(5000) });
    expect(r.status).toBe(413);
  });
});
