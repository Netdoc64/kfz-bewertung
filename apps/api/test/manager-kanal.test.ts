import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kanalFuerKontakt } from "../src/anfragen/kanal.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import type { AppFehler } from "../src/fehler/app-fehler.js";
import { ManagerKanal, alsE164 } from "../src/versand/index.js";

const zugang = { url: "https://manager.test/", hmacSchluessel: "test-schluessel" };
const regeln = { zeitlimitMs: 1000, wiederholungen: 2, abstandMs: 100, abstandMaxMs: 500 };
const n = { an: "+49 170 1234567", text: "Guten Tag", korrelation: "nachricht-1" };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fehlerAntwort = (status: number, code: string, wiederholbar: boolean, headers = {}) => json(status, { ok: false, code, text: "x", wiederholbar }, headers);

function mock(antworten: Array<Response | Error>) {
  const aufrufe: Array<{ url: string; headers: Headers; body: string }> = [];
  const waren: number[] = [];
  const dep = {
    fetch: (async (url: string, init: RequestInit) => {
      aufrufe.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      const a = antworten.shift()!;
      if (a instanceof Error) throw a;
      return a;
    }) as unknown as typeof fetch,
    jetztSekunden: () => 1_700_000_000,
    warte: async (ms: number) => void waren.push(ms),
  };
  return { aufrufe, waren, kanal: new ManagerKanal(zugang, regeln, dep) };
}
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppFehler | null);

async function hmac(schluessel: string, text: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(schluessel), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("ManagerKanal", () => {
  it("sendet signiert an /kfz/versand und liefert externeId", async () => {
    const m = mock([json(200, { ok: true, externeId: "wamid.1", zustand: "eingereiht" })]);
    expect(await m.kanal.sende(n)).toEqual({ externeId: "wamid.1" });
    const a = m.aufrufe[0]!;
    expect(a.url).toBe("https://manager.test/kfz/versand");
    expect(JSON.parse(a.body)).toEqual({ kanal: "whatsapp", an: "+491701234567", text: "Guten Tag", korrelation: "nachricht-1" });
    expect(a.headers.get("x-kfz-zeitstempel")).toBe("1700000000");
    expect(a.headers.get("x-kfz-signatur")).toBe(`sha256=${await hmac("test-schluessel", `1700000000.${a.body}`)}`);
  });

  it("wiederholt bei wiederholbar:true mit derselben Korrelation, Retry-After gedeckelt", async () => {
    const m = mock([fehlerAntwort(429, "FLUTSCHUTZ", true, { "retry-after": "60" }), fehlerAntwort(503, "MANAGER_BUSY", true), json(200, { ok: true, externeId: "w2", zustand: "gesendet" })]);
    expect(await m.kanal.sende(n)).toEqual({ externeId: "w2" });
    expect(m.aufrufe).toHaveLength(3);
    expect(new Set(m.aufrufe.map((a) => JSON.parse(a.body).korrelation))).toEqual(new Set(["nachricht-1"]));
    expect(m.waren).toEqual([500, 100]);
  });

  it("gibt nach den konfigurierten Wiederholungen auf", async () => {
    const m = mock([fehlerAntwort(502, "WHATSAPP_NICHT_ERREICHBAR", true), fehlerAntwort(502, "WHATSAPP_NICHT_ERREICHBAR", true), fehlerAntwort(502, "WHATSAPP_NICHT_ERREICHBAR", true)]);
    const f = await code(m.kanal.sende(n));
    expect(f?.code).toBe("VERSAND_FEHLGESCHLAGEN");
    expect(f?.kontext).toMatchObject({ managerCode: "WHATSAPP_NICHT_ERREICHBAR", http: 502, versuche: 3 });
    expect(m.aufrufe).toHaveLength(3);
  });

  it("wiederholt nicht bei wiederholbar:false", async () => {
    const m = mock([fehlerAntwort(403, "EMPFAENGER_GESPERRT", false)]);
    const f = await code(m.kanal.sende(n));
    expect(f?.code).toBe("VERSAND_FEHLGESCHLAGEN");
    expect(f?.kontext).toMatchObject({ managerCode: "EMPFAENGER_GESPERRT", versuche: 1 });
    expect(m.aufrufe).toHaveLength(1);
  });

  it("Kontext enthält weder Text noch Nummer", async () => {
    const m = mock([fehlerAntwort(403, "EMPFAENGER_GESPERRT", false)]);
    const f = await code(m.kanal.sende(n));
    const s = JSON.stringify([f?.kontext, f?.message]);
    expect(s).not.toContain("1234567");
    expect(s).not.toContain("Guten Tag");
  });

  it("Netzwerkfehler und Zeitlimit werden wiederholt", async () => {
    const zeit = Object.assign(new Error("t"), { name: "TimeoutError" });
    const m = mock([new TypeError("netz"), zeit, json(200, { ok: true, externeId: "w3", zustand: "gesendet" })]);
    expect(await m.kanal.sende(n)).toEqual({ externeId: "w3" });
    expect(m.aufrufe).toHaveLength(3);
  });

  it("200 ohne ok:true gilt nicht als gesendet", async () => {
    const m = mock([json(200, { irgendwas: 1 })]);
    expect((await code(m.kanal.sende(n)))?.kontext).toMatchObject({ managerCode: "antwort_unlesbar" });
    expect(m.aufrufe).toHaveLength(1);
  });

  it("5xx ohne lesbare Fehlerform wird wiederholt, 4xx nicht", async () => {
    const m = mock([new Response("boom", { status: 500 }), json(200, { ok: true, zustand: "gesendet" })]);
    expect(await m.kanal.sende(n)).toEqual({});
    const m2 = mock([new Response("nope", { status: 400 })]);
    await code(m2.kanal.sende(n));
    expect(m2.aufrufe).toHaveLength(1);
  });

  it("ungültige Nummer wird nicht gesendet", async () => {
    const m = mock([]);
    expect((await code(m.kanal.sende({ ...n, an: "0170 123" })))?.code).toBe("VERSAND_FEHLGESCHLAGEN");
    expect(m.aufrufe).toHaveLength(0);
  });

  it("alsE164", () => {
    expect(alsE164("0049 170 1234567")).toBe("+491701234567");
    expect(alsE164("+49 (170) 123-4567")).toBe("+491701234567");
    expect(alsE164("0170 1234567")).toBeNull();
  });
});

describe("kanalFuerKontakt", () => {
  const einst = new Einstellungen(env.DB, async () => {});
  const manager = { url: "https://manager.test", hmacSchluessel: "s" };
  const post = {} as SendEmail;

  it("Telefon → Manager, nur mit vollständigem Zugang", async () => {
    expect((await kanalFuerKontakt(post, einst, "+491701234567", manager))?.name).toBe("whatsapp");
    expect((await kanalFuerKontakt(post, einst, "01701234567", manager))?.name).toBe("whatsapp");
    expect(await kanalFuerKontakt(post, einst, "+491701234567", { url: "https://manager.test" })).toBeNull();
    expect(await kanalFuerKontakt(post, einst, "+491701234567")).toBeNull();
  });

  it("sonst null", async () => {
    expect(await kanalFuerKontakt(post, einst, "Anna", manager)).toBeNull();
    expect(await kanalFuerKontakt(post, einst, "", manager)).toBeNull();
  });

  it("@ → E-Mail (Absender nötig), ohne Binding null", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('mail.absenderAdresse', '\"ankauf@example.de\"', 1, 'test')").run();
    expect((await kanalFuerKontakt(post, new Einstellungen(env.DB, async () => {}), "a@b.de", manager))?.name).toBe("email");
    expect(await kanalFuerKontakt(undefined, einst, "a@b.de", manager)).toBeNull();
    await env.DB.exec("DELETE FROM einstellungen WHERE schluessel='mail.absenderAdresse'");
  });
});
