import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { FehlerAntwort } from "@kfz/shared";
import { dsgvoLoeschung } from "../src/cron/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { app } from "../src/index.js";

const TAG = 86_400_000;
const vor = (tage: number) => new Date(Date.now() - tage * TAG).toISOString();
const post = (pfad: string, body: unknown, umgebung = env) =>
  app.request(`http://lokal/api/admin/dsgvo/${pfad}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, umgebung);
const einst = () => new Einstellungen(env.DB, async () => {});
const zaehle = async (tabelle: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabelle}`).first<{ n: number }>())!.n;
const ERIKA = { kontakt: "erika@example.de", bestaetigung: "erika@example.de" };

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function person(id: string, kontakt: string, status = "abgesagt", geaendert = vor(1)) {
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, dubletten_schluessel, geaendert_am) VALUES (?1, 'email', ?2, 'Erika Muster', ?3, '{}', 'd', ?4)",
  )
    .bind(id, status, kontakt, geaendert)
    .run();
  await env.DB.prepare("INSERT INTO anfrage_nachrichten (anfrage_id, kanal, text, generation, korrelation) VALUES (?1, 'email', 'Mein Freitext', 1, 'k')").bind(id).run();
  await env.DB.prepare("INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_nach, durch, notiz, korrelation) VALUES (?1, 'x', ?2, 'system', 'privat', 'k')").bind(id, status).run();
  await env.DB.prepare("INSERT INTO email_eingang (message_id, anfrage_id) VALUES (?1, ?2)").bind(`m-${id}`, id).run();
  await env.BERICHTE.put(`anhang/${id}`, "foto");
  await env.DB.prepare("INSERT INTO email_anhaenge (id, anfrage_id, r2_schluessel, dateiname, medientyp, groesse) VALUES (?1, ?2, ?3, 'schein.jpg', 'image/jpeg', 4)")
    .bind(`h-${id}`, id, `anhang/${id}`)
    .run();
  await env.BERICHTE.put(`berichte/${id}/1.html`, "<p>bericht</p>");
  await env.DB.prepare(
    "INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck, einstellungs_versionen, gueltig_bis, html_ablage, r2_schluessel) VALUES (?1, ?2, 1, 'de', '{}', '[]', '{}', 'x', '{}', ?3, 'r2', ?4)",
  )
    .bind(`b-${id}`, id, vor(-5), `berichte/${id}/1.html`)
    .run();
  await env.DB.prepare(
    "INSERT INTO nachrichten (id, anfrage_id, kontakt, kanal, anlass, vorlage, sprache, inhalt, status, autopilot, einstellungs_abdruck, korrelation) VALUES (?1, ?2, ?3, 'email', 'eingang', 'v', 'de', 'Hallo Erika', 'gesendet', 'an', 'x', 'k')",
  )
    .bind(`n-${id}`, id, kontakt)
    .run();
}
const speicher = async () => (await env.BERICHTE.list()).objects.map((o) => o.key).sort();

beforeEach(async () => {
  for (const t of ["email_anhaenge", "email_eingang", "nachrichten", "anfrage_nachrichten", "anfrage_ereignisse", "ankaeufe", "berichte", "eingang_geparkt", "anfragen", "einstellungen"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const k of await speicher()) await env.BERICHTE.delete(k);
  await person("a1", "Erika@Example.de");
  await person("a2", "andere@example.de");
  await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES ('g1', 'erika@example.de', 'email', '{\"x\":1}', 'limit', 'k')").run();
});

describe("DSGVO-Auskunft", () => {
  it("liefert alle Daten zum Kontakt über alle Tabellen, ohne fremde", async () => {
    const r = await post("auskunft", { kontakt: " erika@EXAMPLE.de " });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, Record<string, unknown>[]> & { abgeschnitten: boolean };
    expect(b.abgeschnitten).toBe(false);
    expect(b.anfragen!.map((a) => [a.id, a.kunde_name])).toEqual([["a1", "Erika Muster"]]);
    expect(b.nachrichtenVomKunden!.map((n) => n.text)).toEqual(["Mein Freitext"]);
    expect(b.ereignisse!.map((e) => e.notiz)).toEqual(["privat"]);
    expect(b.versandteNachrichten!.map((n) => n.inhalt)).toEqual(["Hallo Erika"]);
    expect(b.geparkteEingaenge!.map((g) => g.id)).toEqual(["g1"]);
    expect(b.emailEingang!.map((m) => m.message_id)).toEqual(["m-a1"]);
    expect(b.anhaenge!.map((h) => h.dateiname)).toEqual(["schein.jpg"]);
    expect(b.anhaenge![0]).not.toHaveProperty("r2_schluessel");
    expect(b.berichte!.map((x) => x.id)).toEqual(["b-a1"]);
    expect(b.berichte![0]).not.toHaveProperty("html");
  });

  it("unbekannter Kontakt: NICHT_GEFUNDEN; ungültige Eingabe: EINGABE_UNGUELTIG", async () => {
    const r = await post("auskunft", { kontakt: "niemand@example.de" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as FehlerAntwort).fehler.code).toBe("NICHT_GEFUNDEN");
    expect((await post("auskunft", {})).status).toBe(400);
  });

  it("meldet Abschneiden an der Obergrenze aus der Registry", async () => {
    await person("a3", "erika@example.de");
    await setze("betrieb.dsgvoAuskunftMaxAnfragen", 1);
    const b = (await (await post("auskunft", { kontakt: "erika@example.de" })).json()) as { abgeschnitten: boolean; anfragen: unknown[] };
    expect([b.abgeschnitten, b.anfragen.length]).toEqual([true, 1]);
  });
});

describe("DSGVO-Einzellöschung", () => {
  it("löscht sofort alles zur Person samt R2-Objekten, fremde Daten bleiben", async () => {
    const r = await post("loeschung", { kontakt: "erika@example.de", bestaetigung: "ERIKA@example.de" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ geloescht: true, anfragen: 1, geparkt: 1, anhaenge: 1, berichte: 1 });
    const a1 = await env.DB.prepare("SELECT kunde_name, kunde_kontakt, dubletten_schluessel, personendaten_geloescht_am FROM anfragen WHERE id = 'a1'").first();
    expect(a1).toMatchObject({ kunde_name: null, kunde_kontakt: null, dubletten_schluessel: null });
    expect(a1!.personendaten_geloescht_am).not.toBeNull();
    expect(await env.DB.prepare("SELECT kontakt, inhalt FROM nachrichten WHERE id = 'n-a1'").first()).toEqual({ kontakt: "", inhalt: "" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM anfrage_nachrichten WHERE anfrage_id = 'a1'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT notiz FROM anfrage_ereignisse WHERE anfrage_id = 'a1' AND aktion = 'x'").first()).toEqual({ notiz: null });
    expect(await env.DB.prepare("SELECT durch, notiz FROM anfrage_ereignisse WHERE anfrage_id = 'a1' AND aktion = 'dsgvo_geloescht'").first()).toEqual({ durch: "entwicklung@lokal", notiz: null });
    expect(await env.DB.prepare("SELECT html, r2_schluessel FROM berichte WHERE id = 'b-a1'").first()).toEqual({ html: null, r2_schluessel: null });
    expect(await zaehle("eingang_geparkt")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM email_anhaenge WHERE anfrage_id = 'a1'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM email_eingang WHERE anfrage_id = 'a1'").first()).toEqual({ n: 0 });
    expect(await speicher()).toEqual(["anhang/a2", "berichte/a2/1.html"]);
    expect(await env.DB.prepare("SELECT kunde_kontakt FROM anfragen WHERE id = 'a2'").first()).toEqual({ kunde_kontakt: "andere@example.de" });
    expect(await zaehle("email_anhaenge")).toBe(1);
  });

  it("zweiter Aufruf: Person nicht mehr auffindbar, Zustand unverändert", async () => {
    await post("loeschung", ERIKA);
    const ereignisse = await zaehle("anfrage_ereignisse");
    const r = await post("loeschung", ERIKA);
    expect(r.status).toBe(404);
    expect(await zaehle("anfrage_ereignisse")).toBe(ereignisse);
  });

  it("Bestätigung muss zum Kontakt passen", async () => {
    const r = await post("loeschung", { kontakt: "erika@example.de", bestaetigung: "falsch@example.de" });
    expect(r.status).toBe(400);
    expect(await speicher()).toHaveLength(4);
  });

  it("Registry betrieb.dsgvoEinzelloeschungOffeneAnfragen = sperren schützt offene Anfragen", async () => {
    await person("a3", "erika@example.de", "an_mensch");
    await setze("betrieb.dsgvoEinzelloeschungOffeneAnfragen", "sperren");
    const r = await post("loeschung", ERIKA);
    expect(r.status).toBe(409);
    expect(((await r.json()) as FehlerAntwort).fehler.code).toBe("DSGVO_OFFENE_ANFRAGE");
    expect(await env.DB.prepare("SELECT kunde_kontakt FROM anfragen WHERE id = 'a1'").first()).toEqual({ kunde_kontakt: "Erika@Example.de" });
    await setze("betrieb.dsgvoEinzelloeschungOffeneAnfragen", "erlauben");
    expect((await post("loeschung", ERIKA)).status).toBe(200);
  });

  it("R2-Fehler: DSGVO_LOESCHUNG_FEHLGESCHLAGEN, Datenbank bleibt unberührt und der Vorgang wiederholbar", async () => {
    const kaputt = { ...env, BERICHTE: { delete: async () => { throw new Error("R2 down"); } } as unknown as R2Bucket };
    const r = await post("loeschung", ERIKA, kaputt);
    expect(r.status).toBe(500);
    expect(((await r.json()) as FehlerAntwort).fehler.code).toBe("DSGVO_LOESCHUNG_FEHLGESCHLAGEN");
    expect(await env.DB.prepare("SELECT kunde_kontakt FROM anfragen WHERE id = 'a1'").first()).toEqual({ kunde_kontakt: "Erika@Example.de" });
    expect((await post("loeschung", ERIKA)).status).toBe(200);
  });
});

describe("Cron dsgvoLoeschung räumt auch Mail-Eingang, Anhänge, R2 und Berichts-HTML", () => {
  it("nur fällige Anfragen, zweiter Lauf ist ein No-op", async () => {
    await env.DB.prepare("UPDATE anfragen SET geaendert_am = ?1 WHERE id = 'a1'").bind(vor(400)).run();
    const e = await dsgvoLoeschung(env.DB, einst(), Date.now(), env.BERICHTE);
    expect(e.bearbeitet).toBe(1);
    expect(await speicher()).toEqual(["anhang/a2", "berichte/a2/1.html"]);
    expect(await zaehle("email_eingang")).toBe(1);
    expect(await zaehle("email_anhaenge")).toBe(1);
    expect((await dsgvoLoeschung(env.DB, einst(), Date.now(), env.BERICHTE)).bearbeitet).toBe(0);
  });
});
