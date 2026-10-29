import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { app } from "../src/index.js";

// Ende-zu-Ende über die echten Routen und den echten Queue-Einstieg; nur Queue-Zustellung und Versand sind gemockt.
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
const post = (pfad: string, body: unknown) =>
  app.request(`http://lokal${pfad}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv());
const aktion = (id: string, a: string, version: number) => post(`/api/admin/anfragen/${id}/aktion`, { aktion: a, version });
const detail = async (id: string) => (await app.request(`http://lokal/api/admin/anfragen/${id}`, undefined, testEnv())).json() as Promise<{ anfrage: { status: string; version: number } }>;
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;
const status = async (id: string) => (await env.DB.prepare("SELECT status FROM anfragen WHERE id = ?1").bind(id).first<{ status: string }>())!.status;
const nachrichten = async () => (await env.DB.prepare("SELECT anlass, status FROM nachrichten ORDER BY rowid").all<{ anlass: string; status: string }>()).results;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

const FORMULAR = {
  name: "Anna Kunde",
  kontakt: "anna@example.de",
  fahrzeug: { marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] },
};

/** Stellt die vom Formular eingereihten Jobs der Queue zu, wie es die Plattform täte. */
async function verarbeiteQueue(): Promise<{ acks: number; retries: number }> {
  const ergebnis = { acks: 0, retries: 0 };
  const batch = {
    queue: "bewertung",
    messages: jobs.splice(0).map((body) => ({ body, ack: () => void ergebnis.acks++, retry: () => void ergebnis.retries++ })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
  await worker.queue!(batch, testEnv(), ctx);
  return ergebnis;
}

beforeEach(async () => {
  jobs = [];
  mails = [];
  await env.DB.exec(
    "DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM eingang_geparkt; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM fehler_ereignisse;",
  );
  await setze("mail.absenderAdresse", "ankauf@example.de");
  // Die Beispieldaten reichen für die Standard-Konfidenz nicht; die Schwelle ist eine Einstellung, kein Code.
  await setze("ablauf.eskalation", { konfidenzMin: 0, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true });
});

/** Formular-POST → Queue → zur_freigabe. */
async function bisZurFreigabe(): Promise<string> {
  const r = await post("/api/anfragen", FORMULAR);
  expect(r.status).toBe(201);
  const { id, status: s } = (await r.json()) as { id: string; status: string };
  expect(s).toBe("eingegangen");
  expect(jobs).toHaveLength(1);
  expect(await verarbeiteQueue()).toEqual({ acks: 1, retries: 0 });
  expect(await status(id)).toBe("zur_freigabe");
  return id;
}

describe("Ende-zu-Ende: Anfrage bis Angebot", () => {
  it("Autopilot an: Formular → zur_freigabe → freigegeben → angebot_versendet, Angebot erst nach Freigabe", async () => {
    const id = await bisZurFreigabe();
    // Bis hierher darf kein Preis beim Kunden gelandet sein.
    expect(mails.filter((m) => /\d\.\d{3}/.test(m.text))).toEqual([]);

    // Ohne Freigabe kein Angebot.
    expect(await code(await aktion(id, "angebot_senden", (await detail(id)).anfrage.version))).toBe("STATUSWECHSEL_UNZULAESSIG");
    expect(mails.filter((m) => m.to === FORMULAR.kontakt && /Angebot/i.test(m.subject))).toEqual([]);

    expect((await aktion(id, "freigeben", (await detail(id)).anfrage.version)).status).toBe(200);
    expect(await status(id)).toBe("freigegeben");

    const vorher = mails.length;
    const r = await aktion(id, "angebot_senden", (await detail(id)).anfrage.version);
    expect(r.status).toBe(200);
    expect(await status(id)).toBe("angebot_versendet");
    expect(mails).toHaveLength(vorher + 1);
    expect(mails.at(-1)!.to).toBe(FORMULAR.kontakt);
    expect(await nachrichten()).toContainEqual({ anlass: "angebot", status: "gesendet" });

    const aktionen = (await env.DB.prepare("SELECT aktion FROM anfrage_ereignisse WHERE anfrage_id = ?1 ORDER BY id").bind(id).all<{ aktion: string }>()).results.map((e) => e.aktion);
    expect(aktionen).toEqual(expect.arrayContaining(["angelegt", "bewertung_starten", "bewertung_fertig", "freigeben", "angebot_senden"]));
  });

  it("Not-Aus aus: Eingang wird angenommen und geparkt, nichts läuft an, nichts geht raus, auch kein Angebot", async () => {
    await setze("ablauf.autopilot", "aus");
    const r = await post("/api/anfragen", FORMULAR);
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(await status(id)).toBe("eingegangen");
    expect(jobs).toHaveLength(0);

    // Auch ein trotzdem zugestellter Job startet nichts.
    jobs.push({ art: "bewertung", anfrageId: id, generation: 1, korrelation: "k-1" });
    expect(await verarbeiteQueue()).toEqual({ acks: 1, retries: 0 });
    expect(await status(id)).toBe("eingegangen");

    // Ein bereits freigegebener Vorgang: das Angebot bleibt gesperrt.
    await env.DB.prepare("UPDATE anfragen SET status = 'freigegeben' WHERE id = ?1").bind(id).run();
    await env.DB.prepare(
      `INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck, einstellungs_versionen, gueltig_bis, html_ablage, html)
       VALUES ('b1', ?1, 1, 'de', '{}', '[]', ?2, 'abc', '{}', ?3, 'd1', '<p>Bericht</p>')`,
    )
      .bind(id, JSON.stringify({ spanne: { vonEuro: 10000, bisEuro: 11000 } }), new Date(Date.now() + 86_400_000).toISOString())
      .run();
    const a = await aktion(id, "angebot_senden", (await detail(id)).anfrage.version);
    expect(await code(a)).toBe("AUTOPILOT_GESPERRT");
    expect(await status(id)).toBe("freigegeben");

    expect(mails).toHaveLength(0);
    expect((await nachrichten()).filter((n) => n.status === "gesendet")).toEqual([]);
  });

  it("nur_verarbeiten: bewertet bis zur Freigabe, aber das Angebot wird geparkt und nichts verlässt das System", async () => {
    await setze("ablauf.autopilot", "nur_verarbeiten");
    const id = await bisZurFreigabe();
    expect((await aktion(id, "freigeben", (await detail(id)).anfrage.version)).status).toBe(200);

    const a = await aktion(id, "angebot_senden", (await detail(id)).anfrage.version);
    expect(a.status).toBe(423);
    expect(await status(id)).toBe("freigegeben");
    expect(mails).toHaveLength(0);
    expect((await nachrichten()).filter((n) => n.status === "gesendet")).toEqual([]);
    expect(await nachrichten()).toContainEqual({ anlass: "angebot", status: "geparkt" });
  });
});
