import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

const anfrage = (e: object = env) => app.request("http://lokal/api/gesund", undefined, e);

describe("GET /api/gesund", () => {
  it("meldet D1, Queue, Abdruck, Autopilot und Quelle-Modus", async () => {
    const r = await anfrage();
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, any>;
    expect(b.ok).toBe(true);
    expect(b.d1).toBe("ok");
    expect(b.queue).toBe("bereit");
    expect(b.einstellungen.abdruck).toMatch(/^[0-9a-f]{12}$/);
    expect(["an", "aus"]).toContain(b.autopilot);
    expect(typeof b.quelleModus).toBe("string");
    expect(typeof b.umgebung).toBe("string");
  });

  it("fehlendes Queue-Binding macht ok=false, bleibt aber lesbar", async () => {
    const b = (await (await anfrage({ ...env, BEWERTUNG_QUEUE: undefined })).json()) as Record<string, any>;
    expect(b.ok).toBe(false);
    expect(b.queue).toBe("fehlt");
  });

  it("D1-Ausfall liefert 500 aus dem Katalog ohne Interna", async () => {
    const kaputt = { ...env, DB: { prepare: () => { throw new Error("D1_ERROR kaputt /secret/pfad"); } } as unknown as D1Database };
    const r = await anfrage(kaputt);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toMatch(/secret|D1_ERROR|kaputt/);
  });

  it("enthält keine Personendaten und keine Geheimnisse", async () => {
    await env.DB.prepare("INSERT INTO anfragen (id, kontakt) VALUES ('g1', 'geheim-person@example.de')").run().catch(() => undefined);
    const t = await (await anfrage()).text();
    expect(t).not.toMatch(/geheim-person|@example|kontakt|token|secret|passwort/i);
    expect(Object.keys(JSON.parse(t)).sort()).toEqual(["autopilot", "d1", "einstellungen", "ok", "quelleModus", "queue", "umgebung"]);
  });
});
