import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailKanal } from "../src/email/versand.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import type { AppFehler } from "../src/fehler/app-fehler.js";
import { sende } from "../src/versand/index.js";

interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}
let mails: Mail[];
const einst = () => new Einstellungen(env.DB, async () => {});
const kanal = (bezug?: ConstructorParameters<typeof EmailKanal>[2]) =>
  new EmailKanal({ send: async (m: Mail) => (mails.push(m), { messageId: `m${mails.length}` }) } as unknown as SendEmail, einst(), bezug);

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function anfrage(id: string, status: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO anfragen (id, kanal, status, fahrzeug) VALUES (?1, 'email', ?2, '{}')").bind(id, status).run();
}
const werte = { name: "Anna", fahrzeug: "VW Golf", ankaufVon: "10.000 €", ankaufBis: "11.000 €", gueltigBis: "01.07.", fehlend: "Kilometer" };
const auftrag = (anlass: string, extra = {}) => ({ kanal: kanal(), an: "anna@example.de", anlass, werte, korrelation: "k1", ...extra });
const fehlerCode = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppFehler | null)?.code;

beforeEach(async () => {
  mails = [];
  await env.DB.exec("DELETE FROM nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen;");
  await setze("mail.absenderAdresse", "ankauf@example.com");
});

describe("E-Mail-Antworten", () => {
  it("Eingang und Rückfrage gehen automatisch per Mail raus, mit Absender aus den Einstellungen", async () => {
    await sende(env.DB, einst(), auftrag("eingang"));
    await sende(env.DB, einst(), auftrag("rueckfrage"));
    expect(mails).toHaveLength(2);
    expect(mails[0]).toMatchObject({ from: "ankauf@example.com", to: "anna@example.de" });
    expect(mails[1]!.text).toContain("Kilometer");
  });

  it("jede Mail trägt Auto-Submitted: auto-replied; mit Bezug auch In-Reply-To und References", async () => {
    await sende(env.DB, einst(), { ...auftrag("eingang"), kanal: kanal({ messageId: "<b@kunde>", references: "<a@kunde>", betreff: "Mein Golf" }) });
    expect(mails[0]!.headers).toEqual({ "Auto-Submitted": "auto-replied", "In-Reply-To": "<b@kunde>", References: "<a@kunde> <b@kunde>" });
    expect(mails[0]!.subject).toBe("Re: Mein Golf");
  });

  it("ohne Bezug: kein Reply-Kopf, Betreff aus den Einstellungen", async () => {
    await sende(env.DB, einst(), auftrag("eingang"));
    expect(Object.keys(mails[0]!.headers)).toEqual(["Auto-Submitted"]);
    expect(mails[0]!.subject).toBe(await einst().lese("mail.antwortBetreff"));
  });

  it("Angebot ohne Freigabe wird abgewiesen, nach der Freigabe gesendet", async () => {
    await anfrage("a1", "zur_freigabe");
    expect(await fehlerCode(sende(env.DB, einst(), auftrag("angebot", { anfrageId: "a1" })))).toBe("FREIGABE_FEHLT");
    expect(mails).toHaveLength(0);
    await anfrage("a1", "freigegeben");
    const r = await sende(env.DB, einst(), auftrag("angebot", { anfrageId: "a1" }));
    expect(r.status).toBe("gesendet");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("10.000 €");
  });

  it("die erste Mail an einen Kontakt enthält den Datenschutzhinweis, die zweite nicht", async () => {
    const hinweis = (await einst().lese("antwort.vorlagen")).de!.datenschutz!.slice(0, 20);
    await sende(env.DB, einst(), auftrag("eingang"));
    await sende(env.DB, einst(), auftrag("rueckfrage"));
    expect(mails[0]!.text).toContain(hinweis);
    expect(mails[1]!.text).not.toContain(hinweis);
  });

  it("Autopilot aus: nichts geht raus", async () => {
    await setze("ablauf.autopilot", "aus");
    expect(await fehlerCode(sende(env.DB, einst(), auftrag("eingang")))).toBe("AUTOPILOT_GESPERRT");
    expect(mails).toHaveLength(0);
  });

  it("ohne Absenderadresse: VERSAND_FEHLGESCHLAGEN, nichts gesendet", async () => {
    await setze("mail.absenderAdresse", "");
    expect(await fehlerCode(sende(env.DB, einst(), auftrag("eingang")))).toBe("VERSAND_FEHLGESCHLAGEN");
    expect(mails).toHaveLength(0);
  });
});
