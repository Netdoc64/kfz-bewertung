import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { app } from "../src/index.js";

interface Mail {
  subject: string;
  text: string;
}
let mails: Mail[];
let jobs: unknown[];

const testEnv = (queueWirft = false) => ({
  ...env,
  BEWERTUNG_QUEUE: {
    send: async (j: unknown) => {
      if (queueWirft) throw new Error("Queue kaputt");
      jobs.push(j);
    },
  } as unknown as Queue<unknown>,
  EMAIL: { send: async (m: Mail) => void mails.push(m) } as unknown as SendEmail,
});
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const holen = (pfad: string) => app.request(`http://lokal/api/admin/dead-letter${pfad}`, {}, testEnv());
const erneut = (id: number, e = testEnv()) => app.request(`http://lokal/api/admin/dead-letter/${id}/erneut`, { method: "POST" }, e);

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

function stapel(nachrichten: { id: string; body: unknown }[]) {
  const bestaetigt: string[] = [];
  const batch = {
    queue: "bewertung-dead-letter",
    messages: nachrichten.map((n) => ({ ...n, attempts: 4, ack: () => void bestaetigt.push(n.id), retry() {} })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  return { batch, bestaetigt };
}
const job = (anfrageId: string, generation = 0) => ({ art: "bewertung", anfrageId, generation, korrelation: "k-1" });
const liefere = (n: { id: string; body: unknown }[], e = testEnv()) => worker.queue!(stapel(n).batch, e, ctx);

beforeEach(async () => {
  mails = [];
  jobs = [];
  await env.DB.exec("DELETE FROM dead_letter; DELETE FROM anfrage_ereignisse; DELETE FROM anfragen; DELETE FROM alarm_ruhe; DELETE FROM fehler_ereignisse; DELETE FROM einstellungen;");
  await setze("mail.absenderAdresse", "alarm@example.com");
  await setze("mail.adminEmpfaenger", ["admin@example.com"]);
  await env.DB.prepare("INSERT INTO anfragen (id, kanal, status, fahrzeug, generation) VALUES ('a1', 'admin', 'in_bewertung', '{}', 2)").run();
});

describe("Dead-Letter: Ablage", () => {
  it("legt den Job ab, bestätigt ihn und meldet DEAD_LETTER", async () => {
    const s = stapel([{ id: "m1", body: job("a1", 2) }]);
    await worker.queue!(s.batch, testEnv(), ctx);
    expect(s.bestaetigt).toEqual(["m1"]);
    const z = await env.DB.prepare("SELECT anfrage_id, job_generation, versuche, erneut_am FROM dead_letter").first();
    expect(z).toEqual({ anfrage_id: "a1", job_generation: 2, versuche: 4, erneut_am: null });
    const f = await env.DB.prepare("SELECT code FROM fehler_ereignisse WHERE code = 'DEAD_LETTER'").first();
    expect(f).not.toBeNull();
  });

  it("legt dieselbe Nachricht bei doppelter Zustellung nur einmal ab", async () => {
    await liefere([{ id: "m1", body: job("a1") }]);
    await liefere([{ id: "m1", body: job("a1") }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM dead_letter").first<{ n: number }>())!.n).toBe(1);
  });

  it("nimmt auch unbrauchbare Nutzlast an, ohne zu werfen", async () => {
    await liefere([{ id: "m2", body: "kaputt" }]);
    const z = await env.DB.prepare("SELECT anfrage_id, nutzlast FROM dead_letter").first();
    expect(z).toEqual({ anfrage_id: null, nutzlast: '"kaputt"' });
  });
});

describe("Dead-Letter: Alarm ab Schwelle", () => {
  it("alarmiert bei Standardschwelle 1 sofort", async () => {
    await liefere([{ id: "m1", body: job("a1") }]);
    expect(mails.some((m) => m.subject.includes("DEAD_LETTER"))).toBe(true);
  });

  it("alarmiert erst, wenn die Schwelle erreicht ist", async () => {
    await setze("betrieb.deadLetterAlarmAb", 2);
    await liefere([{ id: "m1", body: job("a1") }]);
    expect(mails).toHaveLength(0);
    await liefere([{ id: "m2", body: job("a1") }]);
    expect(mails.some((m) => m.subject.includes("DEAD_LETTER"))).toBe(true);
  });

  it("zählt erneut eingereihte Einträge nicht mehr mit", async () => {
    await setze("betrieb.deadLetterAlarmAb", 2);
    await liefere([{ id: "m1", body: job("a1") }]);
    const id = (await env.DB.prepare("SELECT id FROM dead_letter").first<{ id: number }>())!.id;
    await erneut(id);
    await liefere([{ id: "m2", body: job("a1") }]);
    expect(mails).toHaveLength(0);
  });
});

describe("Dead-Letter: Liste und erneut einreihen", () => {
  it("listet offene Einträge, ?alle=1 auch erledigte", async () => {
    await liefere([{ id: "m1", body: job("a1") }]);
    const id = (await env.DB.prepare("SELECT id FROM dead_letter").first<{ id: number }>())!.id;
    const offen = (await (await holen("")).json()) as { eintraege: { id: number; nutzlast: unknown }[] };
    expect(offen.eintraege.map((e) => e.id)).toEqual([id]);
    expect(offen.eintraege[0]!.nutzlast).toEqual(job("a1"));
    await erneut(id);
    expect(((await (await holen("")).json()) as { eintraege: unknown[] }).eintraege).toHaveLength(0);
    expect(((await (await holen("?alle=1")).json()) as { eintraege: unknown[] }).eintraege).toHaveLength(1);
  });

  it("reiht mit neuer Generation ein und ist idempotent", async () => {
    await liefere([{ id: "m1", body: job("a1", 2) }]);
    const id = (await env.DB.prepare("SELECT id FROM dead_letter").first<{ id: number }>())!.id;
    const r1 = await erneut(id);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ bereitsEingereiht: false, erneut_generation: 3 });
    expect(jobs).toEqual([{ art: "bewertung", anfrageId: "a1", generation: 3, korrelation: expect.any(String) }]);
    const r2 = await erneut(id);
    expect(await r2.json()).toMatchObject({ bereitsEingereiht: true, erneut_generation: 3 });
    expect(jobs).toHaveLength(1);
    expect((await env.DB.prepare("SELECT generation FROM anfragen WHERE id = 'a1'").first<{ generation: number }>())!.generation).toBe(3);
  });

  it("gibt den Eintrag frei, wenn die Queue scheitert, damit ein zweiter Versuch geht", async () => {
    await liefere([{ id: "m1", body: job("a1", 2) }]);
    const id = (await env.DB.prepare("SELECT id FROM dead_letter").first<{ id: number }>())!.id;
    expect((await erneut(id, testEnv(true))).status).toBeGreaterThanOrEqual(500);
    expect((await env.DB.prepare("SELECT erneut_am FROM dead_letter").first<{ erneut_am: string | null }>())!.erneut_am).toBeNull();
    expect((await erneut(id)).status).toBe(200);
    expect(jobs).toHaveLength(1);
  });

  it("antwortet 404 für unbekannte Einträge und lehnt Einträge ohne Anfrage ab", async () => {
    expect((await erneut(999)).status).toBe(404);
    expect((await holen("/abc")).status).toBe(404);
    await liefere([{ id: "m3", body: "kaputt" }]);
    const id = (await env.DB.prepare("SELECT id FROM dead_letter").first<{ id: number }>())!.id;
    expect((await erneut(id)).status).toBe(400);
    expect(jobs).toHaveLength(0);
  });
});
