import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";

interface Mail {
  to: string;
  subject: string;
  text: string;
}
let mails: Mail[];

const testEnv = () => ({
  ...env,
  BEWERTUNG_QUEUE: { send: async () => {} } as unknown as Queue<unknown>,
  EMAIL: { send: async (m: Mail) => void mails.push(m) } as unknown as SendEmail,
});
const anfrufen = (pfad: string, body?: unknown) =>
  app.request(`http://lokal${pfad}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv());
const aktion = (id: string, a: string, version: number, extra: object = {}) => anfrufen(`/api/admin/anfragen/${id}/aktion`, { aktion: a, version, ...extra });
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
const FAHRZEUG = JSON.stringify({ marke: "VW", modell: "Golf" });
async function anfrage(id: string, status: string, geaendert = "2026-01-01T00:00:00.000Z") {
  await env.DB.prepare("INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, geaendert_am) VALUES (?1, 'admin', ?2, 'Anna', 'anna@example.de', ?3, ?4)")
    .bind(id, status, FAHRZEUG, geaendert)
    .run();
}
async function bericht(id: string, gueltigBis = new Date(Date.now() + 86_400_000).toISOString(), spanne: object | null = { vonEuro: 10000, bisEuro: 11000 }) {
  await env.DB.prepare(
    `INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck, einstellungs_versionen, gueltig_bis, html_ablage, html)
     VALUES (?1, ?2, 1, 'de', '{}', '[]', ?3, 'abc', '{}', ?4, 'd1', '<p>Bericht</p>')`,
  )
    .bind(`b-${id}`, id, JSON.stringify({ spanne }), gueltigBis)
    .run();
}
const status = async (id: string) => (await env.DB.prepare("SELECT status, version FROM anfragen WHERE id = ?1").bind(id).first<{ status: string; version: number }>())!;
const gesendet = async () => (await env.DB.prepare("SELECT anlass, status FROM nachrichten WHERE anlass = 'angebot'").all()).results;

beforeEach(async () => {
  mails = [];
  await env.DB.exec(
    "DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM fehler_ereignisse;",
  );
  await setze("mail.absenderAdresse", "ankauf@example.de");
});

describe("Admin: Liste", () => {
  it("filtert nach Status, blättert nach ablauf.listeSeitenGroesse und beschriftet aus der Einstellung", async () => {
    await setze("ablauf.listeSeitenGroesse", 2);
    await setze("ablauf.statusBeschriftungen", { zur_freigabe: "Bitte prüfen" });
    await anfrage("a1", "zur_freigabe", "2026-01-01T00:00:00.000Z");
    await anfrage("a2", "zur_freigabe", "2026-01-02T00:00:00.000Z");
    await anfrage("a3", "zur_freigabe", "2026-01-03T00:00:00.000Z");
    await anfrage("a4", "eingegangen");

    const s1 = (await (await anfrufen("/api/admin/anfragen?status=zur_freigabe")).json()) as { eintraege: { id: string; statusText: string }[]; gesamt: number; proSeite: number };
    expect(s1.gesamt).toBe(3);
    expect(s1.proSeite).toBe(2);
    expect(s1.eintraege.map((e) => e.id)).toEqual(["a3", "a2"]);
    expect(s1.eintraege[0]!.statusText).toBe("Bitte prüfen");
    const s2 = (await (await anfrufen("/api/admin/anfragen?status=zur_freigabe&seite=2")).json()) as { eintraege: { id: string }[] };
    expect(s2.eintraege.map((e) => e.id)).toEqual(["a1"]);
    expect(((await (await anfrufen("/api/admin/anfragen")).json()) as { gesamt: number }).gesamt).toBe(4);
  });

  it("unbekannter Status → EINGABE_UNGUELTIG", async () => {
    const r = await anfrufen("/api/admin/anfragen?status=quatsch");
    expect(r.status).toBe(400);
    expect(await code(r)).toBe("EINGABE_UNGUELTIG");
  });
});

describe("Admin: Detail", () => {
  it("liefert Anfrage, Ereignisse, Bericht, Nachrichten und mögliche Aktionen", async () => {
    await anfrage("d1", "zur_freigabe");
    await bericht("d1");
    await env.DB.prepare("INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, korrelation) VALUES ('d1', 'bewertung_fertig', 'in_bewertung', 'zur_freigabe', 'system', 'k')").run();
    await env.DB.prepare("INSERT INTO anfrage_nachrichten (anfrage_id, kanal, text, generation, korrelation) VALUES ('d1', 'email', 'Hallo', 1, 'k')").run();
    const r = await anfrufen("/api/admin/anfragen/d1");
    expect(r.status).toBe(200);
    const b = (await r.json()) as { anfrage: { statusText: string }; ereignisse: unknown[]; kundenNachrichten: unknown[]; bericht: { html: string }; aktionen: { name: string }[] };
    expect(b.anfrage.statusText).toBe("Wartet auf Freigabe");
    expect(b.ereignisse).toHaveLength(1);
    expect(b.kundenNachrichten).toHaveLength(1);
    expect(b.bericht.html).toBe("<p>Bericht</p>");
    expect(b.aktionen.map((a) => a.name)).toEqual(expect.arrayContaining(["freigeben", "ablehnen", "nachbearbeiten"]));
  });

  it("ohne Bericht: bericht null; unbekannte Anfrage → 404", async () => {
    await anfrage("d2", "eingegangen");
    expect(((await (await anfrufen("/api/admin/anfragen/d2")).json()) as { bericht: unknown }).bericht).toBeNull();
    expect((await anfrufen("/api/admin/anfragen/gibt-es-nicht")).status).toBe(404);
  });
});

describe("Admin: Aktion", () => {
  it("freigeben: Status, Version und Ereignis mit Admin-Kennung", async () => {
    await anfrage("f1", "zur_freigabe");
    const r = await aktion("f1", "freigeben", 1, { notiz: "passt" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "freigegeben", statusText: "Freigegeben", version: 2 });
    const e = await env.DB.prepare("SELECT durch, notiz, status_von, status_nach FROM anfrage_ereignisse WHERE anfrage_id = 'f1'").first();
    expect(e).toEqual({ durch: "entwicklung@lokal", notiz: "passt", status_von: "zur_freigabe", status_nach: "freigegeben" });
  });

  it("unzulässige Aktion und Systemaktion → STATUSWECHSEL_UNZULAESSIG", async () => {
    await anfrage("u1", "eingegangen");
    for (const a of ["freigeben", "bewertung_fertig", "gibtsnicht"]) {
      const r = await aktion("u1", a, 1);
      expect(r.status).toBe(409);
      expect(await code(r)).toBe("STATUSWECHSEL_UNZULAESSIG");
    }
    expect((await status("u1")).status).toBe("eingegangen");
  });

  it("veraltete Version → VERSION_KONFLIKT, nichts geändert", async () => {
    await anfrage("v1", "zur_freigabe");
    const r = await aktion("v1", "freigeben", 7);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("VERSION_KONFLIKT");
    expect((await status("v1")).status).toBe("zur_freigabe");
  });

  it("ungültige Eingabe → EINGABE_UNGUELTIG", async () => {
    await anfrage("e1", "zur_freigabe");
    expect(await code(await anfrufen("/api/admin/anfragen/e1/aktion", { aktion: "freigeben" }))).toBe("EINGABE_UNGUELTIG");
  });

  it("angebot_senden: Angebot mit Preis aus dem Bericht geht raus, Status angebot_versendet", async () => {
    await anfrage("s1", "freigegeben");
    await bericht("s1");
    const r = await aktion("s1", "angebot_senden", 1);
    expect(r.status).toBe(200);
    expect((await status("s1")).status).toBe("angebot_versendet");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("anna@example.de");
    expect(mails[0]!.text).toMatch(/10\.000/);
    expect(await gesendet()).toEqual([{ anlass: "angebot", status: "gesendet" }]);
  });

  it("gegenangebot_senden aus verhandlung", async () => {
    await anfrage("g1", "verhandlung");
    await bericht("g1");
    expect((await aktion("g1", "gegenangebot_senden", 1)).status).toBe(200);
    expect((await status("g1")).status).toBe("angebot_versendet");
    expect(mails).toHaveLength(1);
  });

  it("kein Angebot ohne Freigabe: aus zur_freigabe unzulässig, nichts gesendet", async () => {
    await anfrage("n1", "zur_freigabe");
    await bericht("n1");
    expect(await code(await aktion("n1", "angebot_senden", 1))).toBe("STATUSWECHSEL_UNZULAESSIG");
    expect(mails).toHaveLength(0);
    expect(await gesendet()).toEqual([]);
  });

  it("Autopilot nur_verarbeiten: Angebot wird geparkt, Status bleibt freigegeben", async () => {
    await setze("ablauf.autopilot", "nur_verarbeiten");
    await anfrage("p1", "freigegeben");
    await bericht("p1");
    const r = await aktion("p1", "angebot_senden", 1);
    expect(r.status).toBe(423);
    expect((await status("p1")).status).toBe("freigegeben");
    expect(mails).toHaveLength(0);
  });

  it("Autopilot aus: AUTOPILOT_GESPERRT, nichts gesendet", async () => {
    await setze("ablauf.autopilot", "aus");
    await anfrage("p2", "freigegeben");
    await bericht("p2");
    expect(await code(await aktion("p2", "angebot_senden", 1))).toBe("AUTOPILOT_GESPERRT");
    expect((await status("p2")).status).toBe("freigegeben");
    expect(mails).toHaveLength(0);
  });

  it("abgelaufener Bericht → BERICHT_ABGELAUFEN; fehlender Bericht → BERICHT_FEHLT", async () => {
    await anfrage("x1", "freigegeben");
    await bericht("x1", "2020-01-01T00:00:00.000Z");
    expect(await code(await aktion("x1", "angebot_senden", 1))).toBe("BERICHT_ABGELAUFEN");
    await anfrage("x2", "freigegeben");
    expect(await code(await aktion("x2", "angebot_senden", 1))).toBe("BERICHT_FEHLT");
    expect(mails).toHaveLength(0);
  });

  it("Versandfehler → VERSAND_FEHLGESCHLAGEN, Status bleibt", async () => {
    await anfrage("y1", "freigegeben");
    await bericht("y1");
    const kaputt = {
      ...testEnv(),
      EMAIL: {
        send: async () => {
          throw new Error("weg");
        },
      } as unknown as SendEmail,
    };
    const r = await app.request(
      "http://lokal/api/admin/anfragen/y1/aktion",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aktion: "angebot_senden", version: 1 }) },
      kaputt,
    );
    expect(await code(r)).toBe("VERSAND_FEHLGESCHLAGEN");
    expect((await status("y1")).status).toBe("freigegeben");
  });
});
