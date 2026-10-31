import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verarbeiteEmail } from "../src/email/index.js";
import { antwortJson, antwortText, kiAttrappe, type Skript } from "./ki-attrappe.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ZE = "\r\n";

afterEach(() => vi.restoreAllMocks());

interface MailAngaben {
  text: string;
  id?: string;
  /** Bildanhang (Base64 eines Dummys). */
  bild?: { typ: string; name: string };
}

function roh(m: MailAngaben): ForwardableEmailMessage {
  const von = "anna@example.de";
  const kopf = new Headers({ From: `Kunde <${von}>`, Subject: "Anfrage" });
  const zeilen = [`From: Kunde <${von}>`, "To: ankauf@kfz.example", "Subject: Anfrage"];
  if (m.id) {
    kopf.set("Message-ID", `<${m.id}>`);
    zeilen.push(`Message-ID: <${m.id}>`);
  }
  zeilen.push("MIME-Version: 1.0");
  if (m.bild) {
    zeilen.push('Content-Type: multipart/mixed; boundary="g"', "", "--g", 'Content-Type: text/plain; charset="utf-8"', "", m.text, "--g");
    zeilen.push(`Content-Type: ${m.bild.typ}; name="${m.bild.name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${m.bild.name}"`, "", btoa("bilddaten"), "--g--");
  } else {
    zeilen.push('Content-Type: text/plain; charset="utf-8"', "", m.text);
  }
  const bytes = new TextEncoder().encode(zeilen.join(ZE));
  return { headers: kopf, from: von, to: "ankauf@kfz.example", rawSize: bytes.byteLength, raw: new Response(bytes).body } as unknown as ForwardableEmailMessage;
}

const gesendet: Array<{ to: string; subject: string }> = [];
const umgebung = () =>
  ({
    ...env,
    BEWERTUNG_QUEUE: { send: async () => {} },
    EMAIL: { send: async (m: (typeof gesendet)[number]) => (gesendet.push(m), { messageId: `out${gesendet.length}@kfz.example` }) },
  }) as unknown as typeof env;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

async function mitKi(m: MailAngaben, ...skript: Skript[]) {
  const client = kiAttrappe(...skript);
  await verarbeiteEmail(roh(m), umgebung(), ctx, { client });
  return client;
}

const anfragen = () => env.DB.prepare("SELECT id, status, fahrzeug FROM anfragen").all<{ id: string; status: string; fahrzeug: string }>();
const geparkt = () => env.DB.prepare("SELECT grund FROM eingang_geparkt").all<{ grund: string }>();

const AUFRAEUMEN =
  "DELETE FROM email_anhaenge; DELETE FROM email_eingang; DELETE FROM eingang_geparkt; DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM ki_nutzung; DELETE FROM fehler_ereignisse;";

const TEXT = "Ich verkaufe meinen Golf, 120.000 km.";
const gut = (fahrzeug: object, s = 0.95) => antwortJson({ fahrzeug, sicherheit: Object.fromEntries(Object.keys(fahrzeug).map((k) => [k, s])) });

beforeEach(async () => {
  gesendet.length = 0;
  await env.DB.exec(`${AUFRAEUMEN} DELETE FROM einstellungen;`);
  await setze("mail.absenderAdresse", "ankauf@kfz.example");
  await setze("ki.aktiv", true);
  await setze("ki.faehigkeiten", ["freitext_auslesen", "dokument_auslesen"]);
  await setze("betrieb.fehlerSpeichernAbSchwere", "info");
});

describe("E-Mail-Eingang: KI liest Freitext und Foto aus", () => {
  it("hohe Sicherheit: Marke und Modell werden übernommen", async () => {
    const client = await mitKi({ text: TEXT, id: "a1@x" }, gut({ marke: "VW", modell: "Golf" }));
    expect(client.aufrufe).toHaveLength(1);
    const a = (await anfragen()).results;
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.fahrzeug)).toMatchObject({ marke: "VW", modell: "Golf" });
    expect((await geparkt()).results).toHaveLength(0);
  });

  it("niedrige Sicherheit: nichts übernommen, Rückfrage statt Anfrage", async () => {
    await mitKi({ text: TEXT, id: "a2@x" }, gut({ marke: "VW", modell: "Golf" }, 0.3));
    expect((await anfragen()).results).toHaveLength(0);
    expect((await geparkt()).results.map((r) => r.grund)).toEqual(["mail_unklar"]);
    expect(gesendet).toHaveLength(1);
  });

  it("ungültige KI-Ausgabe wird verworfen: gleicher Ablauf wie ohne KI", async () => {
    await mitKi({ text: TEXT, id: "a3@x" }, antwortText("das ist kein JSON"), antwortText("immer noch nicht"));
    expect((await anfragen()).results).toHaveLength(0);
    expect((await geparkt()).results.map((r) => r.grund)).toEqual(["mail_unklar"]);
  });

  it("Antwort mit schemawidrigem Feld (negative Kilometer) wird ganz verworfen", async () => {
    await mitKi({ text: TEXT, id: "a4@x" }, antwortJson({ fahrzeug: { marke: "VW", modell: "Golf", kilometer: -5 }, sicherheit: { marke: 1, modell: 1, kilometer: 1 } }));
    // Die Antwort besteht das Schema der Ausgabe nicht: ganz verworfen.
    expect((await anfragen()).results).toHaveLength(0);
  });

  it("Foto-Anhang wird ausgelesen", async () => {
    const client = await mitKi(
      { text: "Siehe Fahrzeugschein.", id: "a5@x", bild: { typ: "image/jpeg", name: "schein.jpg" } },
      gut({}), // Freitext ohne Treffer
      gut({ marke: "BMW", modell: "320d" }),
    );
    expect(client.aufrufe).toHaveLength(2);
    expect(JSON.stringify(client.aufrufe[1]!.params)).toContain('"type":"image"');
    const a = (await anfragen()).results;
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.fahrzeug)).toMatchObject({ marke: "BMW", modell: "320d" });
  });

  it("PDF-Anhang geht nicht an die KI", async () => {
    const client = await mitKi({ text: "Siehe Anhang.", id: "a6@x", bild: { typ: "application/pdf", name: "schein.pdf" } }, gut({}));
    expect(client.aufrufe).toHaveLength(1);
  });

  it("Widerspruch zwischen Text und Foto: Feld bleibt offen", async () => {
    await mitKi({ text: TEXT, id: "a7@x", bild: { typ: "image/png", name: "s.png" } }, gut({ marke: "VW", modell: "Golf" }), gut({ marke: "Audi", modell: "A3" }));
    expect((await anfragen()).results).toHaveLength(0);
    expect((await geparkt()).results.map((r) => r.grund)).toEqual(["mail_unklar"]);
  });

  it("regelbasiert erkannte Felder haben Vorrang vor der KI", async () => {
    await mitKi({ text: "VW Golf, 90.000 km", id: "a8@x" }, gut({ marke: "Audi", modell: "A3", kilometer: 5 }));
    const a = (await anfragen()).results;
    expect(JSON.parse(a[0]!.fahrzeug)).toMatchObject({ marke: "VW", modell: "Golf", kilometer: 90000 });
  });

  it("KI aus: gleicher Ablauf ohne KI, kein Aufruf", async () => {
    await setze("ki.aktiv", false);
    const client = await mitKi({ text: TEXT, id: "a9@x" });
    expect(client.aufrufe).toHaveLength(0);
    expect((await anfragen()).results).toHaveLength(0);
    expect((await geparkt()).results.map((r) => r.grund)).toEqual(["mail_unklar"]);
  });
});
