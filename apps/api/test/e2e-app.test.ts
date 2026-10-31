import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { app } from "../src/index.js";

// Ende-zu-Ende über die App-API: Kopplung → Anfrage → Freigabe per Geräte-Token → Widerruf. Nur Queue und Versand sind gemockt.
interface Mail {
  to: string;
  subject: string;
  text: string;
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let jobs: unknown[];
let mails: Mail[];

const testEnv = () => ({
  ...env,
  BEWERTUNG_QUEUE: { send: async (j: unknown) => void jobs.push(j) } as unknown as Queue<unknown>,
  EMAIL: { send: async (m: Mail) => void mails.push(m) } as unknown as SendEmail,
});
const anfrage = (pfad: string, init?: RequestInit) => app.request(`http://lokal${pfad}`, init, testEnv());
const post = (pfad: string, body?: unknown, kopf: Record<string, string> = {}) =>
  anfrage(pfad, { method: "POST", headers: { "content-type": "application/json", ...kopf }, body: body === undefined ? undefined : JSON.stringify(body) });
const mitToken = (token: string, pfad: string, body?: unknown) =>
  body === undefined ? anfrage(pfad, { headers: { authorization: `Bearer ${token}` } }) : post(pfad, body, { authorization: `Bearer ${token}` });
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;
const status = async (id: string) => (await env.DB.prepare("SELECT status FROM anfragen WHERE id = ?1").bind(id).first<{ status: string }>())!.status;
const version = async (id: string) => (await env.DB.prepare("SELECT version FROM anfragen WHERE id = ?1").bind(id).first<{ version: number }>())!.version;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

const FORMULAR = {
  name: "Anna Kunde",
  kontakt: "anna@example.de",
  fahrzeug: { marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] },
};

async function verarbeiteQueue(): Promise<void> {
  const batch = {
    queue: "bewertung",
    messages: jobs.splice(0).map((body) => ({ body, ack() {}, retry() {} })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  await worker.queue!(batch, testEnv(), ctx);
}

async function koppeln(): Promise<{ geraetId: string; token: string }> {
  const c = await post("/api/admin/geraete/kopplungscode");
  expect(c.status).toBe(201);
  const r = await post("/api/app/koppeln", { code: ((await c.json()) as { code: string }).code, name: "Handy" });
  expect(r.status).toBe(201);
  return (await r.json()) as { geraetId: string; token: string };
}

async function bisZurFreigabe(): Promise<string> {
  const r = await post("/api/anfragen", FORMULAR);
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  await verarbeiteQueue();
  expect(await status(id)).toBe("zur_freigabe");
  return id;
}

beforeEach(async () => {
  jobs = [];
  mails = [];
  await env.DB.exec(
    "DELETE FROM ankaeufe; DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM eingang_geparkt; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM fehler_ereignisse; DELETE FROM geraete; DELETE FROM kopplungscodes;",
  );
  await setze("mail.absenderAdresse", "ankauf@example.de");
  await setze("ablauf.eskalation", { konfidenzMin: 0, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true });
});

describe("Ende-zu-Ende: App-API", () => {
  it("Code → koppeln → Liste/Detail → Freigabe über die App → Widerruf sperrt sofort", async () => {
    const { token, geraetId } = await koppeln();
    const id = await bisZurFreigabe();

    const liste = (await (await mitToken(token, "/api/app?status=zur_freigabe")).json()) as { anfragen?: { id: string }[]; eintraege?: { id: string }[] };
    expect(JSON.stringify(liste)).toContain(id);
    const d = await mitToken(token, `/api/app/${id}`);
    expect(d.status).toBe(200);

    const r = await mitToken(token, `/api/app/${id}/aktion`, { aktion: "freigeben", version: await version(id) });
    expect(r.status).toBe(200);
    expect(await status(id)).toBe("freigegeben");
    const e = await env.DB.prepare("SELECT durch FROM anfrage_ereignisse WHERE anfrage_id = ?1 AND aktion = 'freigeben'").bind(id).first<{ durch: string }>();
    expect(e).toEqual({ durch: `geraet:${geraetId}` });

    // Veraltete Version → VERSION_KONFLIKT, nichts ändert sich.
    const alt = await mitToken(token, `/api/app/${id}/aktion`, { aktion: "angebot_senden", version: 1 });
    expect(alt.status).toBe(409);
    expect(await code(alt)).toBe("VERSION_KONFLIKT");

    expect((await post(`/api/admin/geraete/${geraetId}/widerrufen`)).status).toBe(200);
    for (const r2 of [await mitToken(token, "/api/app"), await mitToken(token, `/api/app/${id}`), await mitToken(token, `/api/app/${id}/aktion`, { aktion: "angebot_senden", version: await version(id) })]) {
      expect(r2.status).toBe(401);
      expect(await code(r2)).toBe("GERAET_WIDERRUFEN");
    }
    expect(await status(id)).toBe("freigegeben");
  });

  it("ohne Token keine Anfragen", async () => {
    const id = await bisZurFreigabe();
    expect(await code(await anfrage(`/api/app/${id}`))).toBe("NICHT_ANGEMELDET");
  });

  it("Parität: gleiche Aktion im falschen Status → derselbe Fehlercode über App und Admin", async () => {
    const { token } = await koppeln();
    const id = await bisZurFreigabe();
    const body = { aktion: "angebot_senden", version: await version(id) };
    const app1 = await mitToken(token, `/api/app/${id}/aktion`, body);
    const adm = await post(`/api/admin/anfragen/${id}/aktion`, body);
    expect(app1.status).toBe(adm.status);
    expect(await code(app1)).toBe("STATUSWECHSEL_UNZULAESSIG");
    expect(await code(adm)).toBe("STATUSWECHSEL_UNZULAESSIG");
  });

  it("Not-Aus gilt auch über die App: kein Angebot, nichts geht raus", async () => {
    const { token } = await koppeln();
    const id = await bisZurFreigabe();
    expect((await mitToken(token, `/api/app/${id}/aktion`, { aktion: "freigeben", version: await version(id) })).status).toBe(200);
    await setze("ablauf.autopilot", "aus");
    const r = await mitToken(token, `/api/app/${id}/aktion`, { aktion: "angebot_senden", version: await version(id) });
    expect(await code(r)).toBe("AUTOPILOT_GESPERRT");
    expect(await status(id)).toBe("freigegeben");
    expect(mails.filter((m) => /Angebot/i.test(m.subject))).toEqual([]);
  });

  it("Ankauf abschließen über die App verlangt den Preis und speichert ihn", async () => {
    const { token, geraetId } = await koppeln();
    const id = await bisZurFreigabe();
    await env.DB.prepare("UPDATE anfragen SET status = 'angebot_versendet' WHERE id = ?1").bind(id).run();
    const ohne = await mitToken(token, `/api/app/${id}/aktion`, { aktion: "ankauf_abschliessen", version: await version(id) });
    expect(ohne.status).toBe(422);
    expect(await code(ohne)).toBe("ANKAUFSPREIS_UNGUELTIG");
    expect(await status(id)).toBe("angebot_versendet");
    const mit = await mitToken(token, `/api/app/${id}/aktion`, { aktion: "ankauf_abschliessen", version: await version(id), ankaufspreisEuro: 9500 });
    expect(mit.status).toBe(200);
    expect(await status(id)).toBe("angekauft");
    expect(await env.DB.prepare("SELECT preis_euro, erfasst_von FROM ankaeufe WHERE anfrage_id = ?1").bind(id).first()).toEqual({ preis_euro: 9500, erfasst_von: `geraet:${geraetId}` });
  });
});
