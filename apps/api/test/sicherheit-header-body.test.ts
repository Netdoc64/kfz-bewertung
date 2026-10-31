import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";

const anfrage = (pfad: string, init?: RequestInit) => app.request(`http://lokal${pfad}`, init, env);
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM einstellungen WHERE schluessel = 'sicherheit.bodyMaxBytes'").run();
});

describe("A02/A08 Fehlkonfiguration: Sicherheits-Header", () => {
  it.each([
    ["Erfolg", "/api/gesundheit"],
    ["404", "/api/gibt-es-nicht"],
    ["401 (App ohne Token)", "/api/app/x"],
  ])("%s trägt die Header", async (_n, pfad) => {
    const r = await anfrage(pfad);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("keine CORS-Freigabe, auch nicht für fremde Ursprünge", async () => {
    const r = await anfrage("/api/gesundheit", { headers: { origin: "https://boese.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await anfrage("/api/anfragen", { method: "OPTIONS", headers: { origin: "https://boese.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("A04 Ressourcenverbrauch: Body-Größe", () => {
  const post = (pfad: string, body: string) => anfrage(pfad, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("zu großer Body → 413 ANFRAGE_ZU_GROSS, bevor die Route liest", async () => {
    await setze("sicherheit.bodyMaxBytes", 1024);
    const r = await post("/api/anfragen", JSON.stringify({ nachricht: "x".repeat(5000) }));
    expect(r.status).toBe(413);
    expect(await code(r)).toBe("ANFRAGE_ZU_GROSS");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("gilt für öffentliche, Admin- und App-Routen", async () => {
    await setze("sicherheit.bodyMaxBytes", 1024);
    const gross = JSON.stringify({ x: "y".repeat(2000) });
    for (const pfad of ["/api/anfragen", "/api/admin/anfragen", "/api/admin/dsgvo/auskunft", "/api/app/koppeln"]) {
      expect((await post(pfad, gross)).status, pfad).toBe(413);
    }
  });

  it("ohne Content-Length (Strom) wird beim Lesen begrenzt", async () => {
    await setze("sicherheit.bodyMaxBytes", 1024);
    const strom = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"x":"' + "y".repeat(3000) + '"}'));
        c.close();
      },
    });
    const r = await anfrage("/api/anfragen", { method: "POST", headers: { "content-type": "application/json" }, body: strom, duplex: "half" } as RequestInit);
    expect(r.status).toBe(413);
  });

  it("normale Bodys passieren; GET ist nicht betroffen", async () => {
    await setze("sicherheit.bodyMaxBytes", 1024);
    expect((await post("/api/anfragen", "{}")).status).toBe(400);
    expect((await anfrage("/api/gesundheit")).status).toBe(200);
  });

  it("Standardgrenze aus der Registry greift ohne gespeicherten Wert", async () => {
    const r = await post("/api/anfragen", JSON.stringify({ x: "y".repeat(300_000) }));
    expect(r.status).toBe(413);
  });
});
