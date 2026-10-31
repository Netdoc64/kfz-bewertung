import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { berichtLaden } from "../src/bericht/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { app } from "../src/index.js";
import { verarbeiteBewertungsJob } from "../src/queue/bewertungs-job.js";
import { antwortText, kiAttrappe, serverfehler, type Skript } from "./ki-attrappe.js";

interface Mail {
  to: string;
  subject: string;
  text: string;
}
let mails: Mail[];
const testEnv = () => ({ ...env, KI_API_SCHLUESSEL: "test-ohne-wert", EMAIL: { send: async (m: Mail) => void mails.push(m) } as unknown as SendEmail });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
const GOLF = JSON.stringify({ marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] });
const einst = () => new Einstellungen(env.DB, async () => {});
const aktion = (id: string, a: string) =>
  env.DB.prepare("SELECT version FROM anfragen WHERE id = ?1").bind(id).first<{ version: number }>().then((z) =>
    app.request(`http://lokal/api/admin/anfragen/${id}/aktion`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aktion: a, version: z!.version }) }, testEnv()),
  );
const fehlerCodes = async () => (await env.DB.prepare("SELECT DISTINCT code FROM fehler_ereignisse ORDER BY code").all<{ code: string }>()).results.map((r) => r.code);

const ERFUNDEN = "Wir bieten Ihnen sensationelle 99.999 € für Ihren Golf, Marktwert 123.456 € <script>alert(1)</script>";

/** Eine Anfrage vom Job bis zum gesendeten Angebot; mit `skript` läuft die KI, ohne nicht. */
async function lauf(id: string, skript?: Skript[]) {
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, geaendert_am) VALUES (?1, 'admin', 'eingegangen', 'A', ?3, ?2, 1, '2020-01-01T00:00:00.000Z')",
  )
    .bind(id, GOLF, `${id}@example.de`)
    .run();
  const client = skript ? kiAttrappe(...skript) : undefined;
  const ergebnis = await verarbeiteBewertungsJob(env.DB, einst(), { art: "bewertung", anfrageId: id, generation: 1, korrelation: "k-1" }, { env: testEnv(), kiClient: client });
  const bericht = await berichtLaden(env.DB, id);
  mails.length = 0;
  expect((await aktion(id, "freigeben")).status).toBe(200);
  expect((await aktion(id, "angebot_senden")).status).toBe(200);
  return { ergebnis, client, bericht, angebot: mails.find((m) => m.to === `${id}@example.de`)?.text };
}

beforeEach(async () => {
  mails = [];
  await env.DB.exec(
    "DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM fehler_ereignisse; DELETE FROM ki_nutzung;",
  );
  await setze("mail.absenderAdresse", "ankauf@example.de");
  await setze("ablauf.eskalation", { konfidenzMin: 0, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true });
  await setze("betrieb.fehlerSpeichernAbSchwere", "info");
});

const KI_AN = async () => {
  await setze("ki.aktiv", true);
  await setze("ki.faehigkeiten", ["bericht_formulieren"]);
};

describe("KI-Berichtstext", () => {
  it("erfundene Preise der KI ändern weder Zahlen noch Ankaufspreis noch Angebotsnachricht", async () => {
    const ohne = await lauf("o1");
    await KI_AN();
    // Gleiche Einstellungen wie `mit` (ki.* verändert den Abdruck), aber ohne Text: Bezug für den Abdruck.
    const bezug = await lauf("b1", [serverfehler()]);
    const mit = await lauf("m1", [antwortText(ERFUNDEN)]);

    expect(mit.client!.aufrufe).toHaveLength(1);
    expect(JSON.stringify(mit.client!.aufrufe[0]!.params.messages)).not.toContain("99.999");
    expect(mit.bericht.zahlen).toEqual(ohne.bericht.zahlen);
    expect(mit.bericht.zahlen.ankaufspreisEuro).toBe(ohne.bericht.zahlen.ankaufspreisEuro);
    expect(mit.bericht.vergleiche).toEqual(ohne.bericht.vergleiche);
    expect(mit.bericht.einstellungsAbdruck).toBe(bezug.bericht.einstellungsAbdruck);
    expect(mit.angebot).toBeTruthy();
    expect(mit.angebot).toBe(ohne.angebot);
    expect(mit.angebot).not.toContain("99.999");
  });

  it("der KI-Text steht als HTML-escapter Zusatzabsatz im Bericht", async () => {
    await KI_AN();
    const { bericht } = await lauf("m2", [antwortText(ERFUNDEN)]);
    expect(bericht.html).toContain('<p class="ki-text">Wir bieten Ihnen sensationelle 99.999 € für Ihren Golf, Marktwert 123.456 € &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(bericht.html).not.toContain("<script>");
  });

  it("KI aus → identischer Bericht ohne KI-Absatz", async () => {
    const ohne = await lauf("o2");
    await setze("ki.aktiv", false);
    const aus = await lauf("a2", [antwortText(ERFUNDEN)]);
    expect(aus.client!.aufrufe).toHaveLength(0);
    expect(aus.bericht.html).toBe(ohne.bericht.html);
    expect(aus.bericht.html).not.toContain("ki-text");
    expect(aus.bericht.zahlen).toEqual(ohne.bericht.zahlen);
  });

  it("Fähigkeit bericht_formulieren nicht geschaltet → kein Aufruf, kein Absatz", async () => {
    await setze("ki.aktiv", true);
    await setze("ki.faehigkeiten", ["freitext_auslesen"]);
    const r = await lauf("f1", [antwortText(ERFUNDEN)]);
    expect(r.client!.aufrufe).toHaveLength(0);
    expect(r.bericht.html).not.toContain("ki-text");
  });

  it("KI-Fehler → Bericht ohne Text plus Fehlercode", async () => {
    const ohne = await lauf("o3");
    await KI_AN();
    const r = await lauf("e1", [serverfehler()]);
    expect(r.ergebnis).toBe("zur_freigabe");
    expect(r.bericht.html).toBe(ohne.bericht.html);
    expect(r.bericht.zahlen).toEqual(ohne.bericht.zahlen);
    expect(r.angebot).toBe(ohne.angebot);
    expect(await fehlerCodes()).toEqual(["KI_FEHLER"]);
  });

  it("leere KI-Antwort → Bericht ohne Text plus KI_ANTWORT_UNGUELTIG", async () => {
    await KI_AN();
    const r = await lauf("e2", [antwortText("   ")]);
    expect(r.bericht.html).not.toContain("ki-text");
    expect(await fehlerCodes()).toEqual(["KI_ANTWORT_UNGUELTIG"]);
  });
});
