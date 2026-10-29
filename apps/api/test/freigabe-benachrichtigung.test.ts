import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { freigabeErinnerung } from "../src/cron/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { wechsle, type AnfrageKontext, type AnfrageUmgebung, type Zeile } from "../src/anfragen/dienst.js";

const einst = () => new Einstellungen(env.DB, async () => {});
const STUNDE = 3_600_000;
const GOLF = JSON.stringify({ marke: "VW", modell: "Golf" });
const JETZT = Date.parse("2026-06-01T12:00:00.000Z");
const vorStunden = (h: number) => new Date(JETZT - h * STUNDE).toISOString();

interface Gesendet {
  from: string;
  to: string | string[];
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
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function anfrage(id: string, status: string, geaendert: string, generation = 1) {
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, dubletten_schluessel, geaendert_am) VALUES (?1, 'admin', ?2, 'Name', ?3, ?4, ?5, ?1, ?6)",
  )
    .bind(id, status, `${id}@example.de`, GOLF, generation, geaendert)
    .run();
}
const anzahl = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM freigabe_benachrichtigungen").first<{ n: number }>())!.n;

beforeEach(async () => {
  for (const t of ["freigabe_benachrichtigungen", "anfrage_ereignisse", "anfragen", "einstellungen", "fehler_ereignisse", "alarm_ruhe"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await setze("mail.absenderAdresse", "kfz@example.de");
  await setze("mail.adminEmpfaenger", ["admin@example.de"]);
});

describe("Freigabe-Erinnerung (A3)", () => {
  it("meldet neu, erinnert und eskaliert je Stufe genau einmal", async () => {
    const { email, gesendet } = attrappe();
    await anfrage("a1", "zur_freigabe", vorStunden(1));
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT)).toMatchObject({ bearbeitet: 1 });
    expect(gesendet.map((m) => m.subject)).toEqual(["Neue Freigabe wartet: a1"]);

    // Idempotenz: gleicher Zeitpunkt, nichts Neues
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT)).toMatchObject({ bearbeitet: 0 });
    expect(gesendet).toHaveLength(1);

    // nach 4 h (Standard): Erinnerung, zweiter Lauf stumm
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT + 3 * STUNDE)).toMatchObject({ bearbeitet: 1 });
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT + 3.5 * STUNDE)).toMatchObject({ bearbeitet: 0 });
    expect(gesendet[1]!.subject).toContain("Erinnerung");

    // nach 24 h: Eskalation, danach nie wieder
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT + 23 * STUNDE)).toMatchObject({ bearbeitet: 1 });
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT + 100 * STUNDE)).toMatchObject({ bearbeitet: 0 });
    expect(gesendet.map((m) => m.subject.split(":")[0])).toEqual(["Neue Freigabe wartet", "Erinnerung", "Eskalation"]);
    expect(gesendet[0]!.to).toEqual(["admin@example.de"]);
    expect(await anzahl()).toBe(3);
  });

  it("Schwellen kommen aus der Registry", async () => {
    await setze("benachrichtigung.erinnerungNachStunden", 1);
    await setze("benachrichtigung.eskalationNachStunden", 2);
    const { email, gesendet } = attrappe();
    await anfrage("a1", "zur_freigabe", vorStunden(1.5));
    await freigabeErinnerung(env.DB, einst(), email, JETZT);
    expect(gesendet[0]!.subject).toContain("Erinnerung");
  });

  it("ist eine höhere Stufe fällig, entfallen die niedrigeren ohne Mail", async () => {
    const { email, gesendet } = attrappe();
    await anfrage("a1", "zur_freigabe", vorStunden(30));
    await freigabeErinnerung(env.DB, einst(), email, JETZT);
    await freigabeErinnerung(env.DB, einst(), email, JETZT);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]!.subject).toContain("Eskalation");
    expect(await anzahl()).toBe(3);
  });

  it("andere Status und Kanal aus lösen nichts aus", async () => {
    const { email, gesendet } = attrappe();
    await anfrage("a1", "freigegeben", vorStunden(30));
    await anfrage("a2", "zur_freigabe", vorStunden(30));
    await setze("benachrichtigung.kanal", "aus");
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT)).toMatchObject({ bearbeitet: 0, uebersprungen: true });
    expect(gesendet).toHaveLength(0);
    expect(await anzahl()).toBe(0);
  });

  it("scheitert der Versand, bleibt die Stufe offen und der nächste Lauf versucht es erneut", async () => {
    await anfrage("a1", "zur_freigabe", vorStunden(1));
    await expect(freigabeErinnerung(env.DB, einst(), attrappe(true).email, JETZT)).rejects.toMatchObject({ code: "ALARM_FEHLGESCHLAGEN" });
    expect(await anzahl()).toBe(0);
    const { email, gesendet } = attrappe();
    expect(await freigabeErinnerung(env.DB, einst(), email, JETZT)).toMatchObject({ bearbeitet: 1 });
    expect(gesendet).toHaveLength(1);
  });

  it("eine neue Generation (neue Freigabe) wird wieder gemeldet", async () => {
    const { email, gesendet } = attrappe();
    await anfrage("a1", "zur_freigabe", vorStunden(1), 1);
    await freigabeErinnerung(env.DB, einst(), email, JETZT);
    await env.DB.prepare("UPDATE anfragen SET generation = 2 WHERE id = 'a1'").run();
    await freigabeErinnerung(env.DB, einst(), email, JETZT);
    expect(gesendet).toHaveLength(2);
  });

  it("der Wechsel nach zur_freigabe benachrichtigt sofort; die Cron-Aufgabe meldet dann nicht doppelt", async () => {
    const { email, gesendet } = attrappe();
    await anfrage("a1", "in_bewertung", vorStunden(0));
    const u = { db: env.DB, einstellungen: einst(), queue: {} as never, email } as AnfrageUmgebung;
    const z = (await env.DB.prepare("SELECT * FROM anfragen WHERE id = 'a1'").first<Zeile>())!;
    const k: AnfrageKontext = { kanal: "admin", wer: "system", korrelation: "k1" };
    await wechsle(u, z, "bewertung_fertig", "system", k);
    expect(gesendet).toHaveLength(1);
    expect(await freigabeErinnerung(env.DB, einst(), email, Date.now())).toMatchObject({ bearbeitet: 0 });
    expect(gesendet).toHaveLength(1);
  });

  it("scheitert die Sofort-Meldung beim Wechsel, bleibt der Wechsel gültig und der Fehler wird gespeichert", async () => {
    await anfrage("a1", "in_bewertung", vorStunden(0));
    const u = { db: env.DB, einstellungen: einst(), queue: {} as never, email: attrappe(true).email } as AnfrageUmgebung;
    const z = (await env.DB.prepare("SELECT * FROM anfragen WHERE id = 'a1'").first<Zeile>())!;
    await wechsle(u, z, "bewertung_fertig", "system", { kanal: "admin", wer: "system", korrelation: "k1" });
    expect((await env.DB.prepare("SELECT status FROM anfragen WHERE id = 'a1'").first<{ status: string }>())!.status).toBe("zur_freigabe");
    const f = await env.DB.prepare("SELECT code FROM fehler_ereignisse WHERE ort = 'anfragen:freigabe-benachrichtigung'").first<{ code: string }>();
    expect(f!.code).toBe("ALARM_FEHLGESCHLAGEN");
  });
});
