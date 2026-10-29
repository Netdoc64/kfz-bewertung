import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AppFehler } from "../src/fehler/app-fehler.js";
import { mitFehlerspeicher } from "../src/fehler/handler.js";
import { fehlerSpeichern } from "../src/fehler/speicher.js";

interface Gesendet {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

function attrappe(wirft = false) {
  const gesendet: Gesendet[] = [];
  const email = {
    async send(m: Gesendet) {
      if (wirft) throw new Error("Versand kaputt");
      gesendet.push(m);
      return { messageId: "x" };
    },
  } as unknown as SendEmail;
  return { email, gesendet };
}

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')")
    .bind(schluessel, JSON.stringify(wert))
    .run();
}

const meldung = (nachricht = "Kaputt 1", code: "INTERN" | "NICHT_GEFUNDEN" = "INTERN") => ({
  fehler: new AppFehler(code, nachricht, { kontext: { kundeName: "Max Muster" } }),
  ort: "GET /api/test",
  korrelationsId: "korr-12345678",
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM alarm_ruhe; DELETE FROM fehler_ereignisse; DELETE FROM einstellungen;");
  await setze("mail.absenderAdresse", "alarm@example.com");
  await setze("mail.adminEmpfaenger", ["admin@example.com"]);
});

describe("Alarm (A4)", () => {
  it("kritischer Fehler schickt eine Mail ohne Personendaten", async () => {
    const { email, gesendet } = attrappe();
    await fehlerSpeichern(env.DB, meldung("Fehler bei max@kunde.de"), "warnung", email);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]!.to).toEqual(["admin@example.com"]);
    expect(gesendet[0]!.subject).toContain("INTERN");
    expect(gesendet[0]!.text).not.toContain("max@kunde.de");
    expect(gesendet[0]!.text).not.toContain("Max Muster");
  });

  it("derselbe Fingerabdruck alarmiert in der Ruhezeit nur einmal", async () => {
    const { email, gesendet } = attrappe();
    await fehlerSpeichern(env.DB, meldung("Kaputt 1"), "warnung", email);
    await fehlerSpeichern(env.DB, meldung("Kaputt 2"), "warnung", email);
    expect(gesendet).toHaveLength(1);
  });

  it("nach Ablauf der Ruhezeit alarmiert er wieder; ein anderer Fingerabdruck sofort", async () => {
    const { email, gesendet } = attrappe();
    await fehlerSpeichern(env.DB, meldung("Kaputt"), "warnung", email);
    await env.DB.exec("UPDATE alarm_ruhe SET zuletzt_alarmiert = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-61 minutes')");
    await fehlerSpeichern(env.DB, meldung("Kaputt"), "warnung", email);
    expect(gesendet).toHaveLength(2);
    await fehlerSpeichern(env.DB, meldung("Ganz anders"), "warnung", email);
    expect(gesendet).toHaveLength(3);
  });

  it("Ruhezeit kommt aus der Einstellung", async () => {
    await setze("betrieb.alarmRuheMinuten", 0);
    const { email, gesendet } = attrappe();
    await fehlerSpeichern(env.DB, meldung(), "warnung", email);
    await fehlerSpeichern(env.DB, meldung(), "warnung", email);
    expect(gesendet).toHaveLength(2);
  });

  it("unter der Alarmschwelle und bei Kanal aus kommt keine Mail", async () => {
    const { email, gesendet } = attrappe();
    await fehlerSpeichern(env.DB, meldung("x", "NICHT_GEFUNDEN"), "info", email);
    await setze("betrieb.alarmKanal", "aus");
    await fehlerSpeichern(env.DB, meldung(), "warnung", email);
    expect(gesendet).toHaveLength(0);
  });

  it("Versandfehler wirft nicht, der Fehler bleibt gespeichert, nächster Fehler versucht es erneut", async () => {
    const kaputt = attrappe(true);
    await expect(fehlerSpeichern(env.DB, meldung(), "warnung", kaputt.email)).resolves.toBeUndefined();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM fehler_ereignisse").first<{ n: number }>();
    expect(n!.n).toBe(1);
    const gut = attrappe();
    await fehlerSpeichern(env.DB, meldung(), "warnung", gut.email);
    expect(gut.gesendet).toHaveLength(1);
  });

  it("ohne Absender oder Empfänger wirft nichts und es geht nichts raus", async () => {
    await setze("mail.adminEmpfaenger", []);
    const { email, gesendet } = attrappe();
    await expect(fehlerSpeichern(env.DB, meldung(), "warnung", email)).resolves.toBeUndefined();
    expect(gesendet).toHaveLength(0);
  });
});

describe("Alarm außerhalb von HTTP", () => {
  it("mitFehlerspeicher reicht das E-Mail-Binding durch", async () => {
    const { email, gesendet } = attrappe();
    await expect(
      mitFehlerspeicher(env.DB, "queue bewertung", async () => { throw new AppFehler("INTERN", "Queue kaputt"); }, email),
    ).rejects.toThrow();
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]!.subject).toContain("INTERN");
  });
});
