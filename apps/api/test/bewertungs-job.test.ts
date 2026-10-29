import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let gesendet: unknown[];
const testEnv = () => ({ ...env, BEWERTUNG_QUEUE: { send: async (j: unknown) => void gesendet.push(j), sendBatch: async (l: { body: unknown }[]) => void gesendet.push(...l.map((x) => x.body)) } as unknown as Queue<unknown> });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function anfrage(id: string, status = "eingegangen", generation = 1, alt = true) {
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, geaendert_am) VALUES (?1, 'admin', ?2, 'A', ?3, '{}', ?4, ?5)",
  )
    .bind(id, status, `${id}@example.de`, generation, alt ? "2020-01-01T00:00:00.000Z" : new Date().toISOString())
    .run();
}
const status = async (id: string) => (await env.DB.prepare("SELECT status FROM anfragen WHERE id = ?1").bind(id).first<{ status: string }>())!.status;

function liefere(...bodies: unknown[]) {
  const ergebnis = { acks: 0, retries: 0 };
  const batch = {
    queue: "bewertung",
    messages: bodies.map((body) => ({ body, ack: () => void ergebnis.acks++, retry: () => void ergebnis.retries++ })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  return { batch, ergebnis };
}
const job = (anfrageId: string, generation: number) => ({ art: "bewertung", anfrageId, generation, korrelation: "k-1" });
const cron = () => worker.scheduled!({ cron: "*/15 * * * *", scheduledTime: 0, type: "scheduled", noRetry() {} } as ScheduledController, testEnv(), ctx);

beforeEach(async () => {
  gesendet = [];
  for (const t of ["anfrage_ereignisse", "anfragen", "eingang_geparkt", "einstellungen", "fehler_ereignisse"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("Bewertungs-Job", () => {
  it("startet die Bewertung und ist bei erneuter Zustellung ein No-op", async () => {
    await anfrage("a1");
    const l = liefere(job("a1", 1), job("a1", 1));
    await worker.queue!(l.batch, testEnv(), ctx);
    expect(await status("a1")).toBe("in_bewertung");
    expect(l.ergebnis).toEqual({ acks: 2, retries: 0 });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM anfrage_ereignisse WHERE anfrage_id = 'a1' AND aktion = 'bewertung_starten'").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("verwirft einen Job mit älterer Generation (JOB_VERALTET), Status bleibt", async () => {
    await anfrage("a2", "eingegangen", 3);
    const l = liefere(job("a2", 2));
    await worker.queue!(l.batch, testEnv(), ctx);
    expect(await status("a2")).toBe("eingegangen");
    expect(l.ergebnis).toEqual({ acks: 1, retries: 0 });
    // „info“ liegt unter der Standardschwelle des Fehlerspeichers: erwartet kein Eintrag, kein Alarm.
    expect(await env.DB.prepare("SELECT 1 FROM fehler_ereignisse").first()).toBeNull();
  });

  it("neuere Generation als die Anfrage ist kein veralteter Job", async () => {
    await anfrage("a3", "eingegangen", 1);
    await worker.queue!(liefere(job("a3", 2)).batch, testEnv(), ctx);
    expect(await status("a3")).toBe("in_bewertung");
  });

  it("Autopilot aus: nichts startet, Job wird bestätigt", async () => {
    await anfrage("a4");
    await setze("ablauf.autopilot", "aus");
    const l = liefere(job("a4", 1));
    await worker.queue!(l.batch, testEnv(), ctx);
    expect(await status("a4")).toBe("eingegangen");
    expect(l.ergebnis.acks).toBe(1);
  });

  it("unbekannte Anfrage und kaputter Job werden bestätigt und gemeldet, kein Retry-Sturm", async () => {
    const l = liefere(job("gibts-nicht", 1), { quatsch: true });
    await worker.queue!(l.batch, testEnv(), ctx);
    expect(l.ergebnis).toEqual({ acks: 2, retries: 0 });
  });

  it("Status ohne Übergang bewertung_starten (zur_freigabe) bleibt unverändert", async () => {
    await anfrage("a5", "zur_freigabe");
    await worker.queue!(liefere(job("a5", 1)).batch, testEnv(), ctx);
    expect(await status("a5")).toBe("zur_freigabe");
  });
});

describe("Cron: nachholen", () => {
  it("reiht eingegangene Anfragen ein, sobald der Autopilot wieder an ist", async () => {
    await anfrage("c1", "eingegangen", 2);
    await anfrage("c2", "unvollstaendig");
    await setze("ablauf.autopilot", "aus");
    await cron();
    expect(gesendet).toEqual([]);
    await setze("ablauf.autopilot", "an");
    await cron();
    expect(gesendet).toEqual([expect.objectContaining({ art: "bewertung", anfrageId: "c1", generation: 2 })]);
  });

  it("idempotent: zweiter Lauf direkt danach reiht nicht erneut ein; frische Anfragen warten", async () => {
    await anfrage("c3");
    await anfrage("c4", "eingegangen", 1, false);
    await cron();
    await cron();
    expect(gesendet).toHaveLength(1);
  });

  it("respektiert ablauf.nachholenMaxJeLauf", async () => {
    await anfrage("c5");
    await anfrage("c6");
    await setze("ablauf.nachholenMaxJeLauf", 1);
    await cron();
    expect(gesendet).toHaveLength(1);
  });
});

describe("Cron: geparkte Eingänge", () => {
  const parke = (id: string) =>
    env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES (?1, 'x@example.de', 'formular', '{}', 'flutschutz', 'k')").bind(id).run();
  const meldungen = () => env.DB.prepare("SELECT code, anzahl FROM fehler_ereignisse WHERE ort = 'cron:eingang_geparkt'").first<{ code: string; anzahl: number }>();

  it("meldet neue geparkte Eingänge einmal und erst wieder bei neuen", async () => {
    await parke("g1");
    await cron();
    expect(await meldungen()).toEqual({ code: "ZU_VIELE_ANFRAGEN", anzahl: 1 });
    await cron();
    expect((await meldungen())!.anzahl).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    await parke("g2");
    await cron();
    expect((await meldungen())!.anzahl).toBe(2);
  });
});
