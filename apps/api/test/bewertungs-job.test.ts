import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { berichtLaden } from "../src/bericht/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { AppFehler } from "../src/fehler/app-fehler.js";
import worker from "../src/index.js";
import { verarbeiteBewertungsJob } from "../src/queue/bewertungs-job.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let gesendet: unknown[];
const testEnv = () => ({ ...env, BEWERTUNG_QUEUE: { send: async (j: unknown) => void gesendet.push(j), sendBatch: async (l: { body: unknown }[]) => void gesendet.push(...l.map((x) => x.body)) } as unknown as Queue<unknown> });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
const GOLF = JSON.stringify({ marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] });
async function anfrage(id: string, status = "eingegangen", generation = 1, alt = true, fahrzeug = GOLF) {
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, geaendert_am) VALUES (?1, 'admin', ?2, 'A', ?3, ?6, ?4, ?5)",
  )
    .bind(id, status, `${id}@example.de`, generation, alt ? "2020-01-01T00:00:00.000Z" : new Date().toISOString(), fahrzeug)
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
// Die Beispieldaten reichen für die Standard-Konfidenz nicht; die Schwelle ist eine Einstellung, kein Code.
const locker = () => setze("ablauf.eskalation", { konfidenzMin: 0, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true });
const einst = () => new Einstellungen(env.DB, async () => {});
const ereignisse = async (id: string) =>
  (await env.DB.prepare("SELECT aktion, notiz FROM anfrage_ereignisse WHERE anfrage_id = ?1 ORDER BY id").bind(id).all<{ aktion: string; notiz: string | null }>()).results;
const job = (anfrageId: string, generation: number) => ({ art: "bewertung", anfrageId, generation, korrelation: "k-1" });
const cron = () => worker.scheduled!({ cron: "*/15 * * * *", scheduledTime: 0, type: "scheduled", noRetry() {} } as ScheduledController, testEnv(), ctx);

beforeEach(async () => {
  gesendet = [];
  for (const t of ["anfrage_ereignisse", "berichte", "anfragen", "eingang_geparkt", "einstellungen", "fehler_ereignisse"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("Bewertungs-Job", () => {
  it("startet die Bewertung und ist bei erneuter Zustellung ein No-op", async () => {
    await locker();
    await anfrage("a1");
    const l = liefere(job("a1", 1), job("a1", 1));
    await worker.queue!(l.batch, testEnv(), ctx);
    expect(await status("a1")).toBe("zur_freigabe");
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
    await locker();
    await anfrage("a3", "eingegangen", 1);
    await worker.queue!(liefere(job("a3", 2)).batch, testEnv(), ctx);
    expect(await status("a3")).toBe("zur_freigabe");
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

describe("Bewertung und Bericht", () => {
  it("speichert genau einen Bericht, setzt zur_freigabe und schreibt die Ereignisse", async () => {
    await locker();
    await anfrage("b1");
    await verarbeiteBewertungsJob(env.DB, einst(), job("b1", 1), { berichte: env.BERICHTE });
    expect(await status("b1")).toBe("zur_freigabe");
    expect((await ereignisse("b1")).map((e) => e.aktion)).toEqual(["bewertung_starten", "bewertung_fertig"]);
    const b = await berichtLaden(env.DB, "b1", env.BERICHTE);
    expect(b.generation).toBe(1);
    expect(b.zahlen.ankaufspreisEuro).toBeGreaterThan(0);
    expect(b.zahlen.anMensch).toBeNull();
  });

  it("Wiederholung nach fertigem Lauf ist ein No-op (kein zweiter Bericht, kein Ereignis)", async () => {
    await locker();
    await anfrage("b2");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("b2", 1))).toBe("zur_freigabe");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("b2", 1))).toBe("uebersprungen");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM berichte WHERE anfrage_id = 'b2'").first<{ n: number }>())!.n).toBe(1);
    expect(await ereignisse("b2")).toHaveLength(2);
  });

  it("setzt einen unterbrochenen Lauf (Status in_bewertung) fort", async () => {
    await locker();
    await anfrage("b3", "in_bewertung");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("b3", 1))).toBe("zur_freigabe");
    expect((await ereignisse("b3")).map((e) => e.aktion)).toEqual(["bewertung_fertig"]);
  });

  it("Nachbearbeiten erzeugt einen neuen Bericht je Generation", async () => {
    await locker();
    await anfrage("b4");
    await verarbeiteBewertungsJob(env.DB, einst(), job("b4", 1));
    await env.DB.prepare("UPDATE anfragen SET status = 'nachbearbeiten', generation = 2, version = version + 1 WHERE id = 'b4'").run();
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("b4", 2))).toBe("zur_freigabe");
    const g = await env.DB.prepare("SELECT generation FROM berichte WHERE anfrage_id = 'b4' ORDER BY generation").all<{ generation: number }>();
    expect(g.results.map((r) => r.generation)).toEqual([1, 2]);
  });

  it("zu wenige Vergleiche: übergeben mit Grund, Bericht trotzdem gespeichert", async () => {
    await anfrage("u1", "eingegangen", 1, true, JSON.stringify({ marke: "Trabant", modell: "601", ausstattung: [] }));
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("u1", 1))).toBe("an_mensch");
    expect(await status("u1")).toBe("an_mensch");
    expect((await ereignisse("u1"))[1]).toEqual({ aktion: "uebergeben", notiz: expect.stringContaining("zu_wenige_vergleiche") });
    expect((await berichtLaden(env.DB, "u1")).zahlen.ankaufspreisEuro).toBeNull();
  });

  it("Konfidenz unter der Schwelle: an_mensch statt zur_freigabe", async () => {
    await anfrage("u2");
    await setze("ablauf.eskalation", { konfidenzMin: 1, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true });
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("u2", 1))).toBe("an_mensch");
    expect((await ereignisse("u2"))[1]!.notiz).toContain("konfidenz_zu_niedrig");
  });

  it("unbrauchbare Fahrzeugangaben: an_mensch mit Grund", async () => {
    await anfrage("u3", "eingegangen", 1, true, "{}");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("u3", 1))).toBe("an_mensch");
    expect((await ereignisse("u3"))[1]).toEqual({ aktion: "uebergeben", notiz: "fahrzeug_ungueltig" });
  });

  it("wiederholbarer Quellfehler: bleibt in_bewertung, zweiter Versuch gelingt", async () => {
    await locker();
    await anfrage("f1");
    const kaputt = { suche: async (): Promise<never> => { throw new AppFehler("QUELLE_NICHT_ERREICHBAR"); } };
    await expect(verarbeiteBewertungsJob(env.DB, einst(), job("f1", 1), { suche: kaputt })).rejects.toMatchObject({ code: "QUELLE_NICHT_ERREICHBAR" });
    expect(await status("f1")).toBe("in_bewertung");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("f1", 1))).toBe("zur_freigabe");
  });

  it("dauerhafter Quellfehler: fehlgeschlagen mit Code im Ereignis, kein Bericht", async () => {
    await anfrage("f2");
    const kaputt = { suche: async (): Promise<never> => { throw new AppFehler("QUELLE_ANTWORT_UNGUELTIG"); } };
    await expect(verarbeiteBewertungsJob(env.DB, einst(), job("f2", 1), { suche: kaputt })).rejects.toMatchObject({ code: "QUELLE_ANTWORT_UNGUELTIG" });
    expect(await status("f2")).toBe("fehlgeschlagen");
    expect((await ereignisse("f2"))[1]).toEqual({ aktion: "fehlschlag", notiz: "QUELLE_ANTWORT_UNGUELTIG" });
    expect(await env.DB.prepare("SELECT 1 FROM berichte WHERE anfrage_id = 'f2'").first()).toBeNull();
  });

  it("Kunde legt während der Bewertung nach: Ergebnis verworfen (JOB_VERALTET), Status bleibt in_bewertung", async () => {
    await locker();
    await anfrage("g1");
    const nachlegen = {
      suche: async () => {
        await env.DB.prepare("UPDATE anfragen SET generation = 2, version = version + 1 WHERE id = 'g1'").run();
        return [];
      },
    };
    await expect(verarbeiteBewertungsJob(env.DB, einst(), job("g1", 1), { suche: nachlegen })).rejects.toMatchObject({ code: "JOB_VERALTET" });
    expect(await status("g1")).toBe("in_bewertung");
  });

  it("Not-Aus: bei Autopilot aus entsteht weder Bericht noch Statuswechsel", async () => {
    await anfrage("n1");
    await setze("ablauf.autopilot", "aus");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("n1", 1))).toBe("uebersprungen");
    expect(await env.DB.prepare("SELECT 1 FROM berichte").first()).toBeNull();
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
