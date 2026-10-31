import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { berichtsablauf, dsgvoLoeschung, fehlerAufraeumen, referenzAbgleich, rueckfrageTimeout } from "../src/cron/index.js";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import worker from "../src/index.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const einst = () => new Einstellungen(env.DB, async () => {});
const TAG = 86_400_000;
const vor = (tage: number) => new Date(Date.now() - tage * TAG).toISOString();
const GOLF = JSON.stringify({ marke: "VW", modell: "Golf" });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function anfrage(id: string, status: string, geaendert: string) {
  await env.DB.prepare(
    "INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, dubletten_schluessel, geaendert_am) VALUES (?1, 'admin', ?2, 'Name', ?3, ?4, 1, 'd', ?5)",
  )
    .bind(id, status, `${id}@example.de`, GOLF, geaendert)
    .run();
}
async function bericht(anfrageId: string, gueltigBis: string) {
  await env.DB.prepare(
    "INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck, einstellungs_versionen, gueltig_bis, html_ablage, html) VALUES (?1, ?2, 1, 'de', '{}', '[]', '{}', 'x', '{}', ?3, 'd1', '<p/>')",
  )
    .bind(`b-${anfrageId}`, anfrageId, gueltigBis)
    .run();
}
/** Gesamter fachlicher Zustand, ohne das Laufprotokoll selbst. */
async function zustand() {
  const t = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return {
    anfragen: await t("SELECT id, status, version, kunde_name, kunde_kontakt, dubletten_schluessel, personendaten_geloescht_am IS NOT NULL AS geloescht FROM anfragen ORDER BY id"),
    ereignisse: await t("SELECT anfrage_id, aktion, notiz FROM anfrage_ereignisse ORDER BY id"),
    berichte: await t("SELECT id, abgelaufen_am IS NOT NULL AS abgelaufen FROM berichte ORDER BY id"),
    nachrichten: await t("SELECT id, kontakt, inhalt FROM nachrichten ORDER BY id"),
    nachrichtenAnfrage: await t("SELECT id FROM anfrage_nachrichten ORDER BY id"),
    geparkt: await t("SELECT id FROM eingang_geparkt ORDER BY id"),
    fehler: await t("SELECT id FROM fehler_ereignisse ORDER BY id"),
    ruhe: await t("SELECT fingerabdruck FROM alarm_ruhe ORDER BY fingerabdruck"),
  };
}
async function zweimal(lauf: () => Promise<{ bearbeitet: number }>) {
  const erster = await lauf();
  const nachErstem = await zustand();
  const zweiter = await lauf();
  expect(await zustand()).toEqual(nachErstem);
  expect(zweiter.bearbeitet).toBe(0);
  return erster;
}

beforeEach(async () => {
  for (const t of ["cron_laeufe", "anfrage_nachrichten", "nachrichten", "anfrage_ereignisse", "berichte", "anfragen", "eingang_geparkt", "einstellungen", "fehler_ereignisse", "alarm_ruhe"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("Cron-Aufgaben: zweimal laufen, gleicher Endzustand", () => {
  it("Rückfrage-Timeout: nur überfällige gehen an einen Menschen", async () => {
    await anfrage("alt", "unvollstaendig", vor(3));
    await anfrage("neu", "unvollstaendig", vor(0));
    await anfrage("andere", "eingegangen", vor(30));
    const e = await zweimal(() => rueckfrageTimeout(env.DB, einst(), "k-1"));
    expect(e.bearbeitet).toBe(1);
    const z = await zustand();
    expect(z.anfragen.map((a) => [a.id, a.status])).toEqual([["alt", "an_mensch"], ["andere", "eingegangen"], ["neu", "unvollstaendig"]]);
    expect(z.ereignisse).toHaveLength(1);
  });

  it("Rückfrage-Timeout liest die Frist aus der Einstellung", async () => {
    await anfrage("a", "unvollstaendig", vor(3));
    await setze("ablauf.rueckfrageTimeoutStunden", 100);
    expect((await rueckfrageTimeout(env.DB, einst(), "k-1")).bearbeitet).toBe(0);
  });

  it("Berichtsablauf: abgelaufener Bericht markiert, Anfrage an Mensch", async () => {
    await anfrage("a", "zur_freigabe", vor(10));
    await bericht("a", vor(3));
    await anfrage("b", "zur_freigabe", vor(1));
    await bericht("b", new Date(Date.now() + TAG).toISOString());
    const e = await zweimal(() => berichtsablauf(env.DB, "k-1"));
    expect(e.bearbeitet).toBe(2);
    const z = await zustand();
    expect(z.anfragen.map((a) => [a.id, a.status])).toEqual([["a", "an_mensch"], ["b", "zur_freigabe"]]);
    expect(z.berichte.map((b) => b.abgelaufen)).toEqual([1, 0]);
  });

  it("DSGVO-Löschung: nur abgeschlossene Anfragen jenseits der Frist, Anfrage bleibt anonym", async () => {
    await anfrage("alt", "abgesagt", vor(400));
    await anfrage("jung", "abgesagt", vor(10));
    await anfrage("offen", "an_mensch", vor(400));
    await env.DB.prepare("INSERT INTO anfrage_nachrichten (anfrage_id, kanal, text, generation, korrelation) VALUES ('alt', 'email', 'Hallo', 1, 'k')").run();
    await env.DB.prepare("INSERT INTO anfrage_nachrichten (anfrage_id, kanal, text, generation, korrelation) VALUES ('jung', 'email', 'Hallo', 1, 'k')").run();
    await env.DB.prepare(
      "INSERT INTO nachrichten (id, anfrage_id, kontakt, kanal, anlass, vorlage, sprache, inhalt, status, autopilot, einstellungs_abdruck, korrelation) VALUES ('n1', 'alt', 'alt@example.de', 'email', 'eingang', 'v', 'de', 'Text', 'gesendet', 'an', 'x', 'k')",
    ).run();
    await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation, erstellt_am) VALUES ('g-alt', 'x', 'email', '{}', 'g', 'k', ?1)").bind(vor(400)).run();
    await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation, erstellt_am) VALUES ('g-neu', 'x', 'email', '{}', 'g', 'k', ?1)").bind(vor(1)).run();
    const e = await zweimal(() => dsgvoLoeschung(env.DB, einst()));
    expect(e.bearbeitet).toBe(2);
    const z = await zustand();
    const alt = z.anfragen.find((a) => a.id === "alt")!;
    expect([alt.kunde_name, alt.kunde_kontakt, alt.dubletten_schluessel, alt.geloescht]).toEqual([null, null, null, 1]);
    expect(z.anfragen.find((a) => a.id === "jung")!.kunde_kontakt).toBe("jung@example.de");
    expect(z.anfragen.find((a) => a.id === "offen")!.kunde_kontakt).toBe("offen@example.de");
    expect(z.nachrichten).toEqual([{ id: "n1", kontakt: "", inhalt: "" }]);
    expect(z.nachrichtenAnfrage).toHaveLength(1);
    expect(z.geparkt).toEqual([{ id: "g-neu" }]);
  });

  it("Fehleraufräumen: alte Fehler, Ruhezeiten und Cron-Läufe", async () => {
    const f = (fp: string, zuletzt: string) =>
      env.DB.prepare("INSERT INTO fehler_ereignisse (fingerabdruck, code, schwere, ort, nachricht, letzte_korrelation, zuletzt) VALUES (?1, 'X', 'fehler', 'o', 'n', 'k', ?2)").bind(fp, zuletzt).run();
    await f("alt", vor(200));
    await f("neu", vor(1));
    await env.DB.prepare("INSERT INTO alarm_ruhe VALUES ('alt', ?1), ('neu', ?2)").bind(vor(200), vor(1)).run();
    const e = await zweimal(() => fehlerAufraeumen(env.DB, einst()));
    expect(e.bearbeitet).toBe(2);
    const z = await zustand();
    expect(z.fehler).toHaveLength(1);
    expect(z.ruhe).toEqual([{ fingerabdruck: "neu" }]);
  });

  it("Referenzdaten-Abgleich: im Mock-Modus ein protokollierter No-op", async () => {
    const vorher = await zustand();
    const e = await referenzAbgleich(einst());
    expect(e).toMatchObject({ bearbeitet: 0, uebersprungen: true });
    expect(await zustand()).toEqual(vorher);
  });
});

describe("Cron-Lauf über den Scheduler", () => {
  const lauf = () => worker.scheduled!({ cron: "*/15 * * * *", scheduledTime: 0, type: "scheduled", noRetry() {} } as ScheduledController, env, ctx);
  const protokoll = async () => (await env.DB.prepare("SELECT aufgabe, status, korrelation FROM cron_laeufe ORDER BY id").all<{ aufgabe: string; status: string; korrelation: string }>()).results;

  it("protokolliert jede Aufgabe mit gemeinsamer Korrelations-ID; zweiter Lauf ändert den Zustand nicht", async () => {
    await anfrage("alt", "unvollstaendig", vor(3));
    await lauf();
    const nachErstem = await zustand();
    await lauf();
    expect(await zustand()).toEqual(nachErstem);
    const p = await protokoll();
    expect(p).toHaveLength(12);
    expect(p.slice(0, 6).map((x) => x.aufgabe)).toEqual(["rueckfrageTimeout", "freigabeErinnerung", "berichtsablauf", "dsgvoLoeschung", "fehlerAufraeumen", "referenzAbgleich"]);
    expect(new Set(p.slice(0, 6).map((x) => x.korrelation)).size).toBe(1);
    expect(p[5]!.status).toBe("uebersprungen");
  });

  it("abgeschaltete Aufgaben tun nichts und stehen als aus im Protokoll", async () => {
    await setze("betrieb.cronAufgaben", { rueckfrageTimeout: false, freigabeErinnerung: false, berichtsablauf: false, dsgvoLoeschung: false, fehlerAufraeumen: false, referenzAbgleich: false });
    await anfrage("alt", "unvollstaendig", vor(3));
    await lauf();
    expect((await zustand()).anfragen[0]!.status).toBe("unvollstaendig");
    expect((await protokoll()).map((x) => x.status)).toEqual(["aus", "aus", "aus", "aus", "aus", "aus"]);
  });

  it("eine fehlschlagende Aufgabe meldet CRON_FEHLGESCHLAGEN, die übrigen laufen weiter", async () => {
    await env.DB.prepare("DROP TABLE alarm_ruhe").run();
    try {
      await expect(lauf()).rejects.toMatchObject({ code: "CRON_FEHLGESCHLAGEN" });
    } finally {
      await env.DB.prepare("CREATE TABLE alarm_ruhe (fingerabdruck TEXT PRIMARY KEY, zuletzt_alarmiert TEXT NOT NULL)").run();
    }
    const p = await protokoll();
    expect(p.find((x) => x.aufgabe === "fehlerAufraeumen")!.status).toBe("fehler");
    expect(p.find((x) => x.aufgabe === "referenzAbgleich")!.status).toBe("uebersprungen");
    const f = await env.DB.prepare("SELECT code FROM fehler_ereignisse WHERE ort = 'cron:fehlerAufraeumen'").first<{ code: string }>();
    expect(f!.code).toBe("CRON_FEHLGESCHLAGEN");
  });
});
