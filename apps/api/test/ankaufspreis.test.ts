import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { segmentFuer } from "../src/auswertung/index.js";
import { app } from "../src/index.js";

const testEnv = () => ({ ...env, BEWERTUNG_QUEUE: { send: async () => {} } as unknown as Queue<unknown> });
const post = (pfad: string, body: unknown) =>
  app.request(`http://lokal${pfad}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv());
const holen = (pfad: string) => app.request(`http://lokal${pfad}`, {}, testEnv());
const abschluss = (id: string, version: number, extra: object = {}) => post(`/api/admin/anfragen/${id}/aktion`, { aktion: "ankauf_abschliessen", version, ...extra });
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function anfrage(id: string, marke: string, geschaetzt: number | null, status = "angebot_versendet") {
  await env.DB.prepare("INSERT INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'admin', ?2, ?3)").bind(id, status, JSON.stringify({ marke, modell: "X" })).run();
  if (geschaetzt === null) return;
  await env.DB.prepare(
    `INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck, einstellungs_versionen, gueltig_bis, html_ablage, html)
     VALUES (?1, ?2, 1, 'de', '{}', '[]', ?3, 'abc', '{}', '2099-01-01T00:00:00.000Z', 'd1', '<p>B</p>')`,
  )
    .bind(`b-${id}`, id, JSON.stringify({ ankaufspreisEuro: geschaetzt }))
    .run();
}
const zeile = (id: string) => env.DB.prepare("SELECT marke, preis_euro, geschaetzt_euro, erfasst_von FROM ankaeufe WHERE anfrage_id = ?1").bind(id).first<{ marke: string; preis_euro: number; geschaetzt_euro: number | null; erfasst_von: string }>();
const status = async (id: string) => (await env.DB.prepare("SELECT status FROM anfragen WHERE id = ?1").bind(id).first<{ status: string }>())!.status;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM ankaeufe; DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM fehler_ereignisse;");
});

describe("ankauf_abschliessen erfasst den tatsächlichen Preis", () => {
  it("speichert Preis und Schätzung und setzt angekauft", async () => {
    await anfrage("a1", "VW", 10000);
    const r = await abschluss("a1", 1, { ankaufspreisEuro: 9500.456 });
    expect(r.status).toBe(200);
    expect(await status("a1")).toBe("angekauft");
    expect(await zeile("a1")).toMatchObject({ marke: "VW", preis_euro: 9500.46, geschaetzt_euro: 10000 });
  });

  it.each([[{}], [{ ankaufspreisEuro: -5 }], [{ ankaufspreisEuro: "viel" }], [{ ankaufspreisEuro: null }]])("ohne gültigen Preis %j → ANKAUFSPREIS_UNGUELTIG, Status bleibt", async (extra) => {
    await anfrage("a2", "VW", 10000);
    const r = await abschluss("a2", 1, extra);
    expect(r.status).toBe(422);
    expect(await code(r)).toBe("ANKAUFSPREIS_UNGUELTIG");
    expect(await status("a2")).toBe("angebot_versendet");
    expect(await zeile("a2")).toBeNull();
  });

  it("falsche Version → VERSION_KONFLIKT, nichts gespeichert", async () => {
    await anfrage("a3", "VW", 10000);
    const r = await abschluss("a3", 7, { ankaufspreisEuro: 9000 });
    expect(await code(r)).toBe("VERSION_KONFLIKT");
    expect(await zeile("a3")).toBeNull();
  });

  it("andere Aktionen brauchen keinen Preis", async () => {
    await anfrage("a4", "VW", 10000);
    const r = await post("/api/admin/anfragen/a4/aktion", { aktion: "ankauf_abschliessen_gibt_es_nicht", version: 1 });
    expect(await code(r)).toBe("STATUSWECHSEL_UNZULAESSIG");
  });

  it("ohne Bericht wird der Preis ohne Schätzung gespeichert", async () => {
    await anfrage("a5", "BMW", null);
    expect((await abschluss("a5", 1, { ankaufspreisEuro: 4000 })).status).toBe(200);
    expect((await zeile("a5"))!.geschaetzt_euro).toBeNull();
  });
});

describe("Auswertung der Abweichung", () => {
  it("segmentiert nach ankauf.segmentGrenzenEuro", () => {
    expect(segmentFuer(3000, [5000, 15000])).toBe("bis 5000");
    expect(segmentFuer(5000, [15000, 5000])).toBe("bis 5000");
    expect(segmentFuer(9000, [5000, 15000])).toBe("5000–15000");
    expect(segmentFuer(20000, [5000, 15000])).toBe("ab 15000");
    expect(segmentFuer(20000, [])).toBe("alle");
  });

  it("liefert Mittel je Marke und Segment und markiert zu kleine Gruppen", async () => {
    await setze("ankauf.auswertungMindestAnzahl", 2);
    await anfrage("v1", "VW", 10000);
    await anfrage("v2", "VW", 12000);
    await anfrage("v3", "VW", 3000);
    await anfrage("b1", "BMW", 10000);
    await anfrage("o1", "BMW", null);
    for (const [id, preis] of [["v1", 9000], ["v2", 12600], ["v3", 3000], ["b1", 11000], ["o1", 5000]] as const) {
      expect((await abschluss(id, 1, { ankaufspreisEuro: preis })).status).toBe(200);
    }
    const r = await holen("/api/admin/anfragen/auswertung/ankaeufe");
    expect(r.status).toBe(200);
    const b = (await r.json()) as { gesamt: number; ohneSchaetzung: number; zeilen: { marke: string; segment: string; anzahl: number; abweichungEuro: number; abweichungProzent: number; belastbar: boolean }[] };
    expect(b.gesamt).toBe(5);
    expect(b.ohneSchaetzung).toBe(1);
    expect(b.zeilen).toEqual([
      { marke: "BMW", segment: "5000–15000", anzahl: 1, abweichungEuro: 1000, abweichungProzent: 10, belastbar: false },
      { marke: "VW", segment: "5000–15000", anzahl: 2, abweichungEuro: -200, abweichungProzent: -2.5, belastbar: true },
      { marke: "VW", segment: "bis 5000", anzahl: 1, abweichungEuro: 0, abweichungProzent: 0, belastbar: false },
    ]);
  });
});
