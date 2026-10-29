import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import type { AppFehler } from "../src/fehler/app-fehler.js";
import { MockKanal, sende } from "../src/versand/index.js";

const einst = () => new Einstellungen(env.DB, async () => {});

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')")
    .bind(schluessel, JSON.stringify(wert))
    .run();
}
async function anfrage(id: string, status: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'admin', ?2, '{}')").bind(id, status).run();
}
const zeilen = async () => (await env.DB.prepare("SELECT * FROM nachrichten ORDER BY erstellt_am").all<Record<string, unknown>>()).results;
const werte = { name: "Anna", fahrzeug: "VW Golf", ankaufVon: "10.000 €", ankaufBis: "11.000 €", gueltigBis: "01.07.", fehlend: "Kilometer" };
const auftrag = (kanal: MockKanal, anlass: string, extra = {}) => ({ kanal, an: "anna@example.de", anlass, werte, korrelation: "k1", ...extra });
const fehlerCode = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppFehler | null)?.code;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen;");
});

describe("Not-Aus", () => {
  it("an: sendet und speichert mit Abdruck, Kanal, Anlass, Korrelation", async () => {
    const k = new MockKanal();
    const r = await sende(env.DB, einst(), auftrag(k, "eingang"));
    expect(r.status).toBe("gesendet");
    expect(k.gesendet).toHaveLength(1);
    expect(k.gesendet[0]!.text).toContain("Hallo Anna");
    const [z] = await zeilen();
    expect(z).toMatchObject({ kanal: "mock", anlass: "eingang", vorlage: "eingang", korrelation: "k1", status: "gesendet", autopilot: "an" });
    expect(String(z!.einstellungs_abdruck)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("nur_verarbeiten: nichts gesendet, Ergebnis geparkt", async () => {
    await setze("ablauf.autopilot", "nur_verarbeiten");
    const k = new MockKanal();
    const r = await sende(env.DB, einst(), auftrag(k, "eingang"));
    expect(r.status).toBe("geparkt");
    expect(k.gesendet).toHaveLength(0);
    expect((await zeilen())[0]).toMatchObject({ status: "geparkt", autopilot: "nur_verarbeiten" });
  });

  it("aus: nichts gesendet, AUTOPILOT_GESPERRT, Nachricht geparkt gespeichert", async () => {
    await setze("ablauf.autopilot", "aus");
    const k = new MockKanal();
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(k, "eingang")))).toBe("AUTOPILOT_GESPERRT");
    expect(k.gesendet).toHaveLength(0);
    expect((await zeilen())[0]).toMatchObject({ status: "geparkt", autopilot: "aus" });
  });
});

describe("Freigabe", () => {
  it("Angebot ohne freigegebene Anfrage: FREIGABE_FEHLT, nichts gesendet", async () => {
    await anfrage("a1", "zur_freigabe");
    const k = new MockKanal();
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(k, "angebot", { anfrageId: "a1" })))).toBe("FREIGABE_FEHLT");
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(k, "gegenangebot")))).toBe("FREIGABE_FEHLT");
    expect(k.gesendet).toHaveLength(0);
    expect(await zeilen()).toHaveLength(0);
  });

  it("Angebot mit freigegebener Anfrage geht raus", async () => {
    await anfrage("a1", "freigegeben");
    const k = new MockKanal();
    const r = await sende(env.DB, einst(), auftrag(k, "angebot", { anfrageId: "a1" }));
    expect(r.status).toBe("gesendet");
    expect(k.gesendet[0]!.text).toContain("10.000 € bis 11.000 €");
  });

  it("erlaubte Anlässe kommen aus der Registry", async () => {
    const k = new MockKanal();
    expect((await sende(env.DB, einst(), auftrag(k, "rueckfrage"))).status).toBe("gesendet");
    await setze("antwort.automatischErlaubt", ["eingang"]);
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(k, "rueckfrage")))).toBe("FREIGABE_FEHLT");
  });

  it("Not-Aus gilt auch für freigegebene Angebote", async () => {
    await anfrage("a1", "freigegeben");
    await setze("ablauf.autopilot", "nur_verarbeiten");
    const k = new MockKanal();
    expect((await sende(env.DB, einst(), auftrag(k, "angebot", { anfrageId: "a1" }))).status).toBe("geparkt");
    expect(k.gesendet).toHaveLength(0);
  });
});

describe("Datenschutzhinweis (A14)", () => {
  it("nur an die erste gesendete Nachricht je Kontakt", async () => {
    const k = new MockKanal();
    const r1 = await sende(env.DB, einst(), auftrag(k, "eingang"));
    const r2 = await sende(env.DB, einst(), auftrag(k, "rueckfrage"));
    const r3 = await sende(env.DB, einst(), { ...auftrag(k, "eingang"), an: "bob@example.de" });
    expect([r1.datenschutzAngehaengt, r2.datenschutzAngehaengt, r3.datenschutzAngehaengt]).toEqual([true, false, true]);
    expect(k.gesendet[0]!.text).toContain("Datenschutz");
    expect(k.gesendet[1]!.text).not.toContain("Datenschutz");
  });

  it("geparkte Nachricht verbraucht den Hinweis nicht", async () => {
    await setze("ablauf.autopilot", "nur_verarbeiten");
    const k = new MockKanal();
    await sende(env.DB, einst(), auftrag(k, "eingang"));
    await setze("ablauf.autopilot", "an");
    const r = await sende(env.DB, einst(), auftrag(k, "eingang"));
    expect(r.datenschutzAngehaengt).toBe(true);
  });
});

describe("Sonstiges", () => {
  it("Schlüssel macht Wiederholung idempotent", async () => {
    const k = new MockKanal();
    await sende(env.DB, einst(), auftrag(k, "eingang", { schluessel: "s1" }));
    const r = await sende(env.DB, einst(), auftrag(k, "eingang", { schluessel: "s1" }));
    expect(r.wiederholung).toBe(true);
    expect(k.gesendet).toHaveLength(1);
  });

  it("Kanalfehler: VERSAND_FEHLGESCHLAGEN und gespeichert", async () => {
    const k = new MockKanal();
    k.fehler = new Error("down");
    expect(await fehlerCode(sende(env.DB, einst(), auftrag(k, "eingang")))).toBe("VERSAND_FEHLGESCHLAGEN");
    expect((await zeilen())[0]).toMatchObject({ status: "fehlgeschlagen", fehler_code: "VERSAND_FEHLGESCHLAGEN" });
  });

  it("fehlender Platzhalterwert sendet nichts", async () => {
    const k = new MockKanal();
    expect(await fehlerCode(sende(env.DB, einst(), { ...auftrag(k, "eingang"), werte: {} }))).toBe("VERSAND_FEHLGESCHLAGEN");
    expect(k.gesendet).toHaveLength(0);
  });
});
