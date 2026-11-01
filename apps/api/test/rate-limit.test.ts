import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { verarbeiteEmail } from "../src/email/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { AppFehler } from "../src/fehler/app-fehler.js";
import { app } from "../src/index.js";
import { pruefeRatenlimit } from "../src/ratelimit/index.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const einst = () => new Einstellungen(env.DB, async () => {});
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
const von = (ip: string, pfad: string, init: RequestInit = {}) =>
  app.request(`http://lokal${pfad}`, { ...init, headers: { "CF-Connecting-IP": ip, "content-type": "application/json", ...(init.headers as Record<string, string>) } }, env);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ratenzaehler").run();
  await env.DB.prepare("DELETE FROM einstellungen WHERE schluessel LIKE 'ratenlimit.%'").run();
});

describe("Ratenbegrenzung", () => {
  it("Formular: über der Grenze → 429 mit Retry-After, anderer Absender unberührt", async () => {
    await setze("ratenlimit.formular.max", 2);
    for (let i = 0; i < 2; i++) expect((await von("1.1.1.1", "/api/anfragen", { method: "POST", body: "{}" })).status).toBe(400);
    const r = await von("1.1.1.1", "/api/anfragen", { method: "POST", body: "{}" });
    expect(r.status).toBe(429);
    expect(await code(r)).toBe("RATE_LIMIT_UEBERSCHRITTEN");
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await von("2.2.2.2", "/api/anfragen", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("App-API: über der Grenze → 429, auch vor der Geräte-Anmeldung", async () => {
    await setze("ratenlimit.app.max", 1);
    expect((await von("3.3.3.3", "/api/app/x")).status).toBe(401);
    const r = await von("3.3.3.3", "/api/app/x");
    expect(r.status).toBe(429);
    expect(await code(r)).toBe("RATE_LIMIT_UEBERSCHRITTEN");
  });

  it("E-Mail: über der Grenze wird verworfen und protokolliert, ohne Personendaten", async () => {
    await setze("ratenlimit.email.max", 1);
    const mail = () => ({ headers: new Headers({ Subject: "Hallo" }), from: "kunde@example.com", to: "ankauf@kfz.example", rawSize: 0, raw: new Response("").body }) as unknown as ForwardableEmailMessage;
    await verarbeiteEmail(mail(), env, ctx).catch(() => {});
    await verarbeiteEmail(mail(), env, ctx);
    const z = await env.DB.prepare("SELECT anzahl FROM ratenzaehler WHERE kanal = 'email'").first<{ anzahl: number }>();
    expect(z?.anzahl).toBe(2);
    const f = await env.DB.prepare("SELECT * FROM fehler_ereignisse WHERE code = 'RATE_LIMIT_UEBERSCHRITTEN'").all();
    expect(f.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(f.results)).not.toContain("kunde@example.com");
  });

  it("Grenzwert aus geänderter Registry greift; neues Fenster zählt neu", async () => {
    const t = Date.UTC(2026, 0, 1, 12, 0, 0);
    await setze("ratenlimit.email.max", 3);
    await setze("ratenlimit.email.fensterSekunden", 60);
    for (let i = 0; i < 3; i++) await pruefeRatenlimit(env.DB, einst(), "email", "a@example.de", t);
    await expect(pruefeRatenlimit(env.DB, einst(), "email", "a@example.de", t)).rejects.toMatchObject({ code: "RATE_LIMIT_UEBERSCHRITTEN" });
    await pruefeRatenlimit(env.DB, einst(), "email", "a@example.de", t + 60_000);
    // Grenze angehoben: derselbe Zählerstand ist wieder erlaubt.
    await setze("ratenlimit.email.max", 10);
    await pruefeRatenlimit(env.DB, einst(), "email", "a@example.de", t + 60_000);
  });

  it("Fehlerkontext und Tabelle enthalten nur den Hash", async () => {
    await setze("ratenlimit.app.max", 1);
    const e = await (async () => {
      await pruefeRatenlimit(env.DB, einst(), "app", "9.9.9.9");
      return pruefeRatenlimit(env.DB, einst(), "app", "9.9.9.9").catch((x: unknown) => x);
    })();
    expect(e).toBeInstanceOf(AppFehler);
    expect(JSON.stringify((e as AppFehler).kontext)).not.toContain("9.9.9.9");
    const z = await env.DB.prepare("SELECT absender_hash FROM ratenzaehler").first<{ absender_hash: string }>();
    expect(z?.absender_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
