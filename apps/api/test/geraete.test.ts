import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

const anfrage = (pfad: string, init?: RequestInit) => app.request(`http://lokal${pfad}`, init, env);
const post = (pfad: string, body?: unknown, kopf: Record<string, string> = {}) =>
  anfrage(pfad, { method: "POST", headers: { "content-type": "application/json", ...kopf }, body: body === undefined ? undefined : JSON.stringify(body) });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

async function neuerCode(): Promise<string> {
  const r = await post("/api/admin/geraete/kopplungscode");
  expect(r.status).toBe(201);
  return ((await r.json()) as { code: string }).code;
}

async function koppeln(name = "Handy") {
  const r = await post("/api/app/koppeln", { code: await neuerCode(), name });
  expect(r.status).toBe(201);
  return (await r.json()) as { geraetId: string; token: string; ablaufAm: string };
}

const mitToken = (token: string) => anfrage("/api/app/x", { headers: { authorization: `Bearer ${token}` } });
const fehlercode = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

describe("Geräte-Kopplung", () => {
  it("Code gegen Token tauschen; mit Token kommt die Anfrage bis in den Router (404)", async () => {
    const { token } = await koppeln();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await mitToken(token)).status).toBe(404);
  });

  it("Code ist nur einmal einlösbar", async () => {
    const code = await neuerCode();
    expect((await post("/api/app/koppeln", { code, name: "A" })).status).toBe(201);
    const zweites = await post("/api/app/koppeln", { code, name: "B" });
    expect(zweites.status).toBe(401);
    expect(await fehlercode(zweites)).toBe("KOPPLUNGSCODE_UNGUELTIG");
  });

  it("abgelaufener und unbekannter Code → KOPPLUNGSCODE_UNGUELTIG", async () => {
    const code = await neuerCode();
    await env.DB.prepare("UPDATE kopplungscodes SET ablauf_am = '2000-01-01T00:00:00.000Z'").run();
    const r = await post("/api/app/koppeln", { code, name: "A" });
    expect(r.status).toBe(401);
    expect(await fehlercode(r)).toBe("KOPPLUNGSCODE_UNGUELTIG");
    expect(await fehlercode(await post("/api/app/koppeln", { code: "NICHTVORHANDEN", name: "A" }))).toBe("KOPPLUNGSCODE_UNGUELTIG");
  });

  it("Code und Token liegen nie im Klartext in D1", async () => {
    const code = await neuerCode();
    const r = await post("/api/app/koppeln", { code, name: "Handy" });
    const { token } = (await r.json()) as { token: string };
    const alles = JSON.stringify([(await env.DB.prepare("SELECT * FROM geraete").all()).results, (await env.DB.prepare("SELECT * FROM kopplungscodes").all()).results]);
    expect(alles).not.toContain(token);
    expect(alles).not.toContain(code);
  });

  it("Ohne, mit falschem Token → NICHT_ANGEMELDET", async () => {
    expect(await fehlercode(await anfrage("/api/app/x"))).toBe("NICHT_ANGEMELDET");
    const r = await mitToken("falsch");
    expect(r.status).toBe(401);
    expect(await fehlercode(r)).toBe("NICHT_ANGEMELDET");
  });

  it("Widerruf greift sofort → GERAET_WIDERRUFEN", async () => {
    const { token, geraetId } = await koppeln();
    expect((await mitToken(token)).status).toBe(404);
    expect((await post(`/api/admin/geraete/${geraetId}/widerrufen`)).status).toBe(200);
    const r = await mitToken(token);
    expect(r.status).toBe(401);
    expect(await fehlercode(r)).toBe("GERAET_WIDERRUFEN");
    expect((await post("/api/admin/geraete/gibtsnicht/widerrufen")).status).toBe(404);
  });

  it("abgelaufenes Token wird abgewiesen", async () => {
    const { token, geraetId } = await koppeln();
    await env.DB.prepare("UPDATE geraete SET ablauf_am = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(geraetId).run();
    expect(await fehlercode(await mitToken(token))).toBe("NICHT_ANGEMELDET");
  });

  it("Laufzeiten kommen aus der Registry", async () => {
    await setze("app.tokenLaufzeitTage", 7);
    await setze("app.kopplungscodeGueltigMinuten", 3);
    const t0 = Date.now();
    const c = (await (await post("/api/admin/geraete/kopplungscode")).json()) as { code: string; ablaufAm: string };
    expect(Date.parse(c.ablaufAm) - t0).toBeGreaterThan(2.9 * 60_000);
    expect(Date.parse(c.ablaufAm) - t0).toBeLessThan(3.1 * 60_000);
    const k = (await (await post("/api/app/koppeln", { code: c.code, name: "H" })).json()) as { ablaufAm: string };
    const tage = (Date.parse(k.ablaufAm) - t0) / 86_400_000;
    expect(tage).toBeGreaterThan(6.99);
    expect(tage).toBeLessThan(7.01);
  });

  it("Liste zeigt Geräte ohne Token-Hash", async () => {
    await koppeln("Liste-Handy");
    const r = await anfrage("/api/admin/geraete");
    const text = await r.text();
    expect(text).toContain("Liste-Handy");
    expect(text).not.toContain("token_hash");
  });

  it("Koppeln ohne Gerätenamen → EINGABE_UNGUELTIG", async () => {
    expect((await post("/api/app/koppeln", { code: await neuerCode() })).status).toBe(400);
  });
});
