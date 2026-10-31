/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

const testEnv = () => ({ ...env, BEWERTUNG_QUEUE: { send: async () => {} } as unknown as Queue<unknown> });
const anfrage = (pfad: string, init?: RequestInit) => app.request(`http://lokal${pfad}`, init, testEnv());
const post = (pfad: string, body?: unknown, kopf: Record<string, string> = {}) =>
  anfrage(pfad, { method: "POST", headers: { "content-type": "application/json", ...kopf }, body: body === undefined ? undefined : JSON.stringify(body) });
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

const FORMULAR = {
  name: "Anna Kunde",
  kontakt: "anna@example.de",
  fahrzeug: { marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] },
};

async function koppeln(): Promise<string> {
  const c = await post("/api/admin/geraete/kopplungscode");
  const r = await post("/api/app/koppeln", { code: ((await c.json()) as { code: string }).code, name: "Handy" });
  return ((await r.json()) as { token: string }).token;
}

describe("A03 BOPLA / Mass Assignment", () => {
  it("das öffentliche Formular ignoriert eingeschleuste Felder (Status, ID, Version, Preis, Kanal)", async () => {
    const r = await post("/api/anfragen", { ...FORMULAR, id: "meine-id", status: "freigegeben", version: 99, generation: 7, kanal: "admin", preis: 99999, ankaufspreisEuro: 1 });
    expect(r.status).toBe(201);
    const antwort = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(antwort).sort()).toEqual(["id", "status"]);
    expect(antwort.id).not.toBe("meine-id");
    const z = await env.DB.prepare("SELECT status, version, generation, kanal FROM anfragen WHERE id = ?1").bind(antwort.id).first<{ status: string; version: number; generation: number; kanal: string }>();
    expect(z).toMatchObject({ kanal: "formular", version: 1 });
    expect(z!.status).not.toBe("freigegeben");
    expect(z!.generation).toBeLessThan(7);
  });

  it("die Antwort an Unbekannte enthält nie einen Preis", async () => {
    const text = await (await post("/api/anfragen", FORMULAR)).text();
    expect(text).not.toMatch(/preis|euro|spanne/i);
  });
});

describe("A06 Sensible Abläufe: kein Preis ohne Freigabe", () => {
  it("angebot_senden ist für eine frische Anfrage unzulässig – über Admin- wie App-Weg", async () => {
    const { id } = (await (await post("/api/anfragen", FORMULAR)).json()) as { id: string };
    const admin = await post(`/api/admin/anfragen/${id}/aktion`, { aktion: "angebot_senden", version: 1 });
    expect(admin.status).toBe(409);
    expect(await code(admin)).toBe("STATUSWECHSEL_UNZULAESSIG");
    const token = await koppeln();
    const app_ = await post(`/api/app/${id}/aktion`, { aktion: "angebot_senden", version: 1 }, { authorization: `Bearer ${token}` });
    expect(app_.status).toBe(409);
    expect(await code(app_)).toBe("STATUSWECHSEL_UNZULAESSIG");
    const nachrichten = await env.DB.prepare("SELECT COUNT(*) AS n FROM nachrichten WHERE anfrage_id = ?1 AND richtung = 'aus'").bind(id).first<{ n: number }>().catch(() => ({ n: 0 }));
    expect(nachrichten?.n ?? 0).toBe(0);
  });

  it("ein Ankaufspreis wird nur als endliche, nicht negative Zahl angenommen", async () => {
    const { id } = (await (await post("/api/anfragen", FORMULAR)).json()) as { id: string };
    for (const preis of ["viel", -5, null, {}, Number.MAX_VALUE * 10]) {
      const r = await post(`/api/admin/anfragen/${id}/aktion`, { aktion: "ankauf_abschliessen", version: 1, ankaufspreisEuro: preis });
      expect(r.status, String(preis)).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("A01 BOLA / Objekt-Zugriff", () => {
  it("fremde und ungültige Objekt-IDs ergeben 404, nie Daten oder 500", async () => {
    const token = await koppeln();
    for (const pfad of ["/api/admin/anfragen/gibt-es-nicht", "/api/admin/geparkt/x", "/api/admin/dead-letter/abc", "/api/admin/dead-letter/1.5", "/api/admin/dead-letter/99999"]) {
      expect((await anfrage(pfad)).status, pfad).toBe(404);
    }
    expect((await anfrage("/api/app/gibt-es-nicht", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  it("ein Anhang ist nur über seinen Eingang abrufbar; falsche Paarung ergibt 404", async () => {
    await env.BERICHTE.put("anhaenge/test/a1", "BILD");
    await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES ('g1','a@example.de','email','{}','mail_unklar','k'), ('g2','b@example.de','email','{}','mail_unklar','k')").run();
    await env.DB.prepare("INSERT INTO email_anhaenge (id, geparkt_id, r2_schluessel, dateiname, medientyp, groesse) VALUES ('a1','g1','anhaenge/test/a1','schein\"\r\n.html','text/html',4)").run();
    expect((await anfrage("/api/admin/geparkt/g2/anhaenge/a1")).status).toBe(404);
    const r = await anfrage("/api/admin/geparkt/g1/anhaenge/a1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(r.headers.get("content-disposition")).not.toMatch(/[\r\n"]/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("A02/A09 Fehlerantworten geben nichts preis", () => {
  it("ungültige Eingabe wiederholt keine Eingabewerte", async () => {
    const r = await post("/api/anfragen", { ...FORMULAR, kontakt: "geheim-person@example.de", fahrzeug: { marke: 5 } });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain("geheim-person");
  });

  it("5xx zeigt nur den Katalogtext, ohne Stacktrace oder Pfade", async () => {
    const kaputt = { ...testEnv(), DB: { prepare: () => { throw new Error("D1 kaputt bei /secret/pfad"); } } as unknown as D1Database };
    const r = await app.request("http://lokal/api/gesundheit", undefined, kaputt);
    expect(r.status).toBe(500);
    const t = await r.text();
    expect(t).not.toMatch(/secret|D1 kaputt|\.ts:|at /);
  });

  it("eine fremde Korrelations-ID mit Sonderzeichen wird nicht gespiegelt", async () => {
    const r = await anfrage("/api/gesundheit", { headers: { "X-Korrelations-Id": "x\"><script>alert(1)</script>" } });
    expect(r.headers.get("x-korrelations-id")).not.toContain("<");
  });
});

describe("A10 SSRF / A10 unsichere Fremd-APIs", () => {
  it("keine Route nimmt eine URL vom Aufrufer entgegen: Schemas der Routen kennen kein url/uri/host-Feld", async () => {
    const quellen = import.meta.glob("../src/routen/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(quellen).length).toBeGreaterThan(5);
    for (const [datei, quelle] of Object.entries(quellen)) {
      expect(quelle, datei).not.toMatch(/fetch\s*\(/);
      expect(quelle, datei).not.toMatch(/z\.string\(\)\.url\(|z\.url\(|(url|uri|host|callback)\s*:\s*z\./i);
    }
  });
});
