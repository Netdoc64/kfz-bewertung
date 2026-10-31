import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.js";

interface Mail {
  to: string;
  subject: string;
  text: string;
}
let jobs: unknown[];
let mails: Mail[];

const testEnv = () => ({
  ...env,
  BEWERTUNG_QUEUE: { send: async (j: unknown) => void jobs.push(j) } as unknown as Queue<unknown>,
  EMAIL: { send: async (m: Mail) => void mails.push(m) } as unknown as SendEmail,
});

function post(pfad: string, body: unknown) {
  return app.request(`http://lokal${pfad}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv());
}

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')")
    .bind(schluessel, JSON.stringify(wert))
    .run();
}

const vollstaendig = { marke: "VW", modell: "Golf", erstzulassung: "2019-05", kilometer: 80000, kraftstoff: "benzin" };
const eingabe = (extra: Record<string, unknown> = {}, fahrzeug: Record<string, unknown> = vollstaendig) => ({
  name: "Anna",
  kontakt: "anna@example.de",
  fahrzeug,
  ...extra,
});
const zeile = (id: string) => env.DB.prepare("SELECT * FROM anfragen WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const ereignisse = async (id: string) =>
  (await env.DB.prepare("SELECT aktion, status_von, status_nach, durch FROM anfrage_ereignisse WHERE anfrage_id = ?1 ORDER BY id").bind(id).all()).results;
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

beforeEach(async () => {
  jobs = [];
  mails = [];
  await env.DB.exec(
    "DELETE FROM email_anhaenge; DELETE FROM email_eingang; DELETE FROM nachrichten; DELETE FROM anfrage_nachrichten; DELETE FROM eingang_geparkt; DELETE FROM anfrage_ereignisse; DELETE FROM berichte; DELETE FROM anfragen; DELETE FROM einstellungen; DELETE FROM fehler_ereignisse;",
  );
  await setze("mail.absenderAdresse", "ankauf@example.de");
});

describe("Anfrage anlegen", () => {
  it("Formular: vollständige Angaben → eingegangen, Ereignis, Job der Generation 1", async () => {
    const r = await post("/api/anfragen", eingabe());
    expect(r.status).toBe(201);
    const b = (await r.json()) as { id: string; status: string };
    expect(b.status).toBe("eingegangen");
    expect(await ereignisse(b.id)).toEqual([{ aktion: "angelegt", status_von: null, status_nach: "eingegangen", durch: "system" }]);
    expect(jobs).toEqual([expect.objectContaining({ art: "bewertung", anfrageId: b.id, generation: 1 })]);
    expect(mails).toHaveLength(0);
  });

  it("Admin: kanal admin, Ereignis mit Admin-Kennung", async () => {
    const r = await post("/api/admin/anfragen", eingabe());
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await zeile(id))!.kanal).toBe("admin");
    expect((await ereignisse(id))[0]).toMatchObject({ aktion: "angelegt", durch: "entwicklung@lokal" });
    expect(jobs).toHaveLength(1);
  });

  it("ungültige Eingabe → EINGABE_UNGUELTIG, nichts gespeichert", async () => {
    const r = await post("/api/anfragen", { name: "A", kontakt: "a@b.de", fahrzeug: { marke: "VW" } });
    expect(r.status).toBe(400);
    expect(await code(r)).toBe("EINGABE_UNGUELTIG");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM anfragen").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("Pflichtangaben und Rückfragen", () => {
  const luecke = { marke: "VW", modell: "Golf", kraftstoff: "benzin" };

  it("fehlende Angaben → unvollstaendig, Rückfrage per Mail, kein Job", async () => {
    const r = await post("/api/anfragen", eingabe({}, luecke));
    const b = (await r.json()) as { id: string; status: string };
    expect(b.status).toBe("unvollstaendig");
    expect(jobs).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("anna@example.de");
    expect(mails[0]!.text).toContain("Erstzulassung (Monat und Jahr), Kilometerstand");
    expect((await zeile(b.id))!.rueckfragen).toBe(1);
    expect((await ereignisse(b.id)).map((e) => e.aktion)).toEqual(["angelegt", "angaben_fehlen"]);
  });

  it("Feldbeschriftungen kommen aus der Einstellung; ohne Eintrag steht der Feldname", async () => {
    await setze("antwort.feldBeschriftungen", { de: { erstzulassung: "Datum der Erstzulassung" } });
    await post("/api/anfragen", eingabe({}, luecke));
    expect(mails[0]!.text).toContain("Datum der Erstzulassung, kilometer");
  });

  it("Pflichtangaben kommen aus der Einstellung", async () => {
    await setze("antwort.pflichtangaben", ["getriebe"]);
    const r = await post("/api/anfragen", eingabe({}, luecke));
    expect(((await r.json()) as { status: string }).status).toBe("unvollstaendig");
    expect(mails[0]!.text).toContain("Getriebe");
  });

  it("Antwort mit den Angaben → eingegangen, Job mit höherer Generation", async () => {
    const { id } = (await (await post("/api/anfragen", eingabe({}, luecke))).json()) as { id: string };
    const r = await post(`/api/admin/anfragen/${id}/nachrichten`, { text: "Hier die Daten", fahrzeug: { erstzulassung: "2018-01", kilometer: 90000 } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("eingegangen");
    expect(jobs).toEqual([expect.objectContaining({ anfrageId: id, generation: 2 })]);
    expect((await ereignisse(id)).map((e) => e.aktion)).toEqual(["angelegt", "angaben_fehlen", "angaben_ergaenzt"]);
    expect(JSON.parse((await zeile(id))!.fahrzeug as string)).toMatchObject({ marke: "VW", kilometer: 90000, kraftstoff: "benzin" });
  });

  it("nach ablauf.maxRueckfragen → an_mensch statt weiterer Rückfrage", async () => {
    const { id } = (await (await post("/api/anfragen", eingabe({}, luecke))).json()) as { id: string };
    await post(`/api/admin/anfragen/${id}/nachrichten`, { text: "weiß nicht" });
    expect(mails).toHaveLength(2);
    const r = await post(`/api/admin/anfragen/${id}/nachrichten`, { text: "immer noch nicht" });
    expect(((await r.json()) as { status: string }).status).toBe("an_mensch");
    expect(mails).toHaveLength(2);
    expect((await ereignisse(id)).at(-1)).toMatchObject({ aktion: "uebergeben", status_nach: "an_mensch", durch: "system" });
  });

  it("maxRueckfragen 0 → sofort an_mensch, keine Mail", async () => {
    await setze("ablauf.maxRueckfragen", 0);
    const b = (await (await post("/api/anfragen", eingabe({}, luecke))).json()) as { status: string };
    expect(b.status).toBe("an_mensch");
    expect(mails).toHaveLength(0);
  });

  it("Kontakt ohne Mailadresse → an_mensch mit Grund, nie still", async () => {
    const b = (await (await post("/api/anfragen", eingabe({ kontakt: "+491701234567" }, luecke))).json()) as { id: string; status: string };
    expect(b.status).toBe("an_mensch");
    const e = await env.DB.prepare("SELECT notiz FROM anfrage_ereignisse WHERE anfrage_id = ?1 AND aktion = 'uebergeben'").bind(b.id).first<{ notiz: string }>();
    expect(e!.notiz).toBeTruthy();
  });

  it("Not-Aus aus: Rückfrage wird geparkt statt gesendet", async () => {
    await setze("ablauf.autopilot", "aus");
    const b = (await (await post("/api/anfragen", eingabe({}, luecke))).json()) as { status: string };
    expect(b.status).toBe("unvollstaendig");
    expect(mails).toHaveLength(0);
    const n = await env.DB.prepare("SELECT status FROM nachrichten WHERE anlass = 'rueckfrage'").first<{ status: string }>();
    expect(n!.status).toBe("geparkt");
  });

  it("Not-Aus aus: Anfrage angenommen, aber nicht eingereiht", async () => {
    await setze("ablauf.autopilot", "aus");
    const r = await post("/api/anfragen", eingabe());
    expect(r.status).toBe(201);
    expect(jobs).toHaveLength(0);
  });
});

describe("A8: Nachricht während der Bewertung", () => {
  it("erhöht die Generation und reiht neu ein; Nachricht gespeichert", async () => {
    const { id } = (await (await post("/api/anfragen", eingabe())).json()) as { id: string };
    await env.DB.prepare("UPDATE anfragen SET status = 'in_bewertung' WHERE id = ?1").bind(id).run();
    const r = await post(`/api/admin/anfragen/${id}/nachrichten`, { text: "Übrigens: 5 Reifen neu" });
    expect(r.status).toBe(200);
    expect((await zeile(id))!.generation).toBe(2);
    expect(jobs.map((j) => (j as { generation: number }).generation)).toEqual([1, 2]);
    const n = await env.DB.prepare("SELECT text, generation FROM anfrage_nachrichten WHERE anfrage_id = ?1").bind(id).all();
    expect(n.results).toEqual([{ text: "Übrigens: 5 Reifen neu", generation: 2 }]);
  });

  it("nach der Freigabe-Stufe bleibt die Generation, kein neuer Job", async () => {
    const { id } = (await (await post("/api/anfragen", eingabe())).json()) as { id: string };
    await env.DB.prepare("UPDATE anfragen SET status = 'zur_freigabe' WHERE id = ?1").bind(id).run();
    await post(`/api/admin/anfragen/${id}/nachrichten`, { text: "Hallo?" });
    expect((await zeile(id))!.generation).toBe(1);
    expect(jobs).toHaveLength(1);
  });

  it("unbekannte Anfrage → NICHT_GEFUNDEN", async () => {
    const r = await post("/api/admin/anfragen/gibtsnicht/nachrichten", { text: "x" });
    expect(r.status).toBe(404);
  });
});

describe("Dubletten", () => {
  const mitFin = (extra = {}) => eingabe(extra, { ...vollstaendig, fin: "WVWZZZ1KZAW123456" });

  it("gleicher Kunde + FIN im Fenster → DUBLETTE", async () => {
    expect((await post("/api/anfragen", mitFin())).status).toBe(201);
    const r = await post("/api/anfragen", mitFin({ kontakt: "ANNA@example.de" }));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe("DUBLETTE");
    expect(jobs).toHaveLength(1);
  });

  it("Kennzeichen zählt, Schreibweise egal", async () => {
    await post("/api/anfragen", eingabe({ kennzeichen: "B-AB 123" }));
    const r = await post("/api/anfragen", eingabe({ kennzeichen: "b ab123" }));
    expect(await code(r)).toBe("DUBLETTE");
  });

  it("anderer Kunde, gleiche FIN → keine Dublette", async () => {
    await post("/api/anfragen", mitFin());
    expect((await post("/api/anfragen", mitFin({ kontakt: "bernd@example.de" }))).status).toBe(201);
  });

  it("außerhalb von ablauf.dublettenFensterTage → keine Dublette", async () => {
    const { id } = (await (await post("/api/anfragen", mitFin())).json()) as { id: string };
    await env.DB.prepare("UPDATE anfragen SET erstellt_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = ?1").bind(id).run();
    await setze("ablauf.dublettenFensterTage", 7);
    expect((await post("/api/anfragen", mitFin())).status).toBe(201);
  });

  it("innerhalb des Fensters nach Verkürzen der Einstellung noch Dublette", async () => {
    const { id } = (await (await post("/api/anfragen", mitFin())).json()) as { id: string };
    await env.DB.prepare("UPDATE anfragen SET erstellt_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = ?1").bind(id).run();
    expect(await code(await post("/api/anfragen", mitFin()))).toBe("DUBLETTE");
  });
});

describe("A9: Flutschutz", () => {
  it("über eingang.maxJeAbsenderUndTag wird geparkt, Fehler gespeichert, kein Job", async () => {
    await setze("eingang.maxJeAbsenderUndTag", 2);
    for (let i = 0; i < 2; i++) expect((await post("/api/anfragen", eingabe())).status).toBe(201);
    const r = await post("/api/anfragen", eingabe());
    expect(r.status).toBe(202);
    expect(jobs).toHaveLength(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM anfragen").first<{ n: number }>())!.n).toBe(2);
    const g = await env.DB.prepare("SELECT kontakt, grund FROM eingang_geparkt").all();
    expect(g.results).toEqual([{ kontakt: "anna@example.de", grund: "flutschutz" }]);
    const f = await env.DB.prepare("SELECT code FROM fehler_ereignisse").all();
    expect(f.results).toEqual([{ code: "ZU_VIELE_ANFRAGEN" }]);
  });

  it("geparkte Eingänge zählen weiter mit; anderer Absender ist nicht betroffen", async () => {
    await setze("eingang.maxJeAbsenderUndTag", 1);
    await post("/api/anfragen", eingabe());
    await post("/api/anfragen", eingabe());
    await post("/api/anfragen", eingabe());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM eingang_geparkt").first<{ n: number }>())!.n).toBe(2);
    expect((await post("/api/anfragen", eingabe({ kontakt: "bernd@example.de" }))).status).toBe(201);
  });

  it("Anfragen von gestern zählen nicht", async () => {
    await setze("eingang.maxJeAbsenderUndTag", 1);
    const { id } = (await (await post("/api/anfragen", eingabe())).json()) as { id: string };
    await env.DB.prepare("UPDATE anfragen SET erstellt_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days') WHERE id = ?1").bind(id).run();
    expect((await post("/api/anfragen", eingabe())).status).toBe(201);
  });

  it("Admin ist vom Flutschutz ausgenommen", async () => {
    await setze("eingang.maxJeAbsenderUndTag", 1);
    await post("/api/admin/anfragen", eingabe());
    expect((await post("/api/admin/anfragen", eingabe())).status).toBe(201);
  });
});

describe("Admin-Ansicht geparkter Eingänge", () => {
  const admin = (pfad: string, method = "GET") => app.request(`http://lokal/api/admin/geparkt${pfad}`, { method }, testEnv());

  async function parke(): Promise<string> {
    await setze("eingang.maxJeAbsenderUndTag", 1);
    await post("/api/anfragen", eingabe());
    await post("/api/anfragen", eingabe({}, { ...vollstaendig, modell: "Polo" }));
    const l = (await (await admin("")).json()) as { eintraege: { id: string }[] };
    return l.eintraege[0]!.id;
  }

  it("listet offene Eingänge mit Nutzlast, prüfen setzt nur das Kennzeichen", async () => {
    const id = await parke();
    const g = (await (await admin(`/${id}`)).json()) as { nutzlast: { name: string }; geprueft_am: string | null };
    expect(g.nutzlast.name).toBe("Anna");
    expect(g.geprueft_am).toBeNull();
    const p = (await (await admin(`/${id}/pruefen`, "POST")).json()) as { geprueft_am: string | null; entscheidung: string | null };
    expect(p.geprueft_am).not.toBeNull();
    expect(p.entscheidung).toBeNull();
    const ungeprueft = (await (await admin("?ungeprueft=1")).json()) as { eintraege: unknown[] };
    expect(ungeprueft.eintraege).toHaveLength(0);
  });

  it("freigeben legt die Anfrage an und reiht ein; zweites Mal abgewiesen", async () => {
    const id = await parke();
    const vorher = jobs.length;
    const r = await admin(`/${id}/freigeben`, "POST");
    expect(r.status).toBe(201);
    const a = (await r.json()) as { id: string };
    expect(jobs.length).toBe(vorher + 1);
    const z = await env.DB.prepare("SELECT entscheidung, anfrage_id FROM eingang_geparkt WHERE id = ?1").bind(id).first();
    expect(z).toEqual({ entscheidung: "freigegeben", anfrage_id: a.id });
    expect(await code(await admin(`/${id}/freigeben`, "POST"))).toBe("STATUSWECHSEL_UNZULAESSIG");
    expect(((await (await admin("")).json()) as { eintraege: unknown[] }).eintraege).toHaveLength(0);
  });

  it("verwerfen entscheidet ohne Anfrage; unbekannte ID ist 404", async () => {
    const id = await parke();
    const v = (await (await admin(`/${id}/verwerfen`, "POST")).json()) as { entscheidung: string };
    expect(v.entscheidung).toBe("verworfen");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM anfragen").first<{ n: number }>())!.n).toBe(1);
    expect((await admin("/gibtsnicht")).status).toBe(404);
  });

  it("scheitert die Freigabe (Dublette), bleibt der Eingang offen", async () => {
    const id = await parke();
    const mitKz = eingabe({ kennzeichen: "B AB 123" });
    await env.DB.prepare("UPDATE eingang_geparkt SET nutzlast = ?2 WHERE id = ?1").bind(id, JSON.stringify(mitKz)).run();
    await env.DB.prepare("UPDATE anfragen SET dubletten_schluessel = 'anna@example.de|kz:BAB123'").run();
    expect(await code(await admin(`/${id}/freigeben`, "POST"))).toBe("DUBLETTE");
    const z = await env.DB.prepare("SELECT entscheidung FROM eingang_geparkt WHERE id = ?1").bind(id).first();
    expect(z).toEqual({ entscheidung: null });
  });

  describe("mail_unklar mit Anhang", () => {
    async function parkeMail(): Promise<string> {
      const id = crypto.randomUUID();
      const nutzlast = { name: "Bernd", betreff: "Mein Auto", text: "Bitte bewerten", messageId: "m1@x" };
      await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES (?1, 'bernd@example.de', 'email', ?2, 'mail_unklar', 'k')")
        .bind(id, JSON.stringify(nutzlast))
        .run();
      const schluessel = `anhaenge/geparkt-${id}/a1`;
      await env.BERICHTE.put(schluessel, new Uint8Array([1, 2, 3]));
      await env.DB.prepare("INSERT INTO email_anhaenge (id, geparkt_id, r2_schluessel, dateiname, medientyp, groesse) VALUES ('a1', ?1, ?2, 'schein.jpg', 'image/jpeg', 3)").bind(id, schluessel).run();
      await env.DB.prepare("INSERT INTO email_eingang (message_id, geparkt_id) VALUES ('m1@x', ?1)").bind(id).run();
      return id;
    }
    const freigabe = (id: string, body: unknown) =>
      app.request(`http://lokal/api/admin/geparkt/${id}/freigeben`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, testEnv());

    it("Detail zeigt Anhänge, Download liefert die Bytes, fremde ID ist 404", async () => {
      const id = await parkeMail();
      const d = (await (await admin(`/${id}`)).json()) as { anhaenge: { id: string; dateiname: string }[] };
      expect(d.anhaenge).toMatchObject([{ id: "a1", dateiname: "schein.jpg" }]);
      const r = await admin(`/${id}/anhaenge/a1`);
      expect(r.headers.get("content-type")).toBe("image/jpeg");
      expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
      expect((await admin(`/${id}/anhaenge/gibtsnicht`)).status).toBe(404);
    });

    it("Freigabe ohne Fahrzeugangaben wird abgewiesen, Eingang bleibt offen", async () => {
      const id = await parkeMail();
      expect(await code(await freigabe(id, {}))).toBe("EINGABE_UNGUELTIG");
      expect(await env.DB.prepare("SELECT entscheidung FROM eingang_geparkt WHERE id = ?1").bind(id).first()).toEqual({ entscheidung: null });
    });

    it("Freigabe legt die Anfrage an und hängt Anhänge und Mail-Zuordnung um", async () => {
      const id = await parkeMail();
      const r = await freigabe(id, { fahrzeug: vollstaendig });
      expect(r.status).toBe(201);
      const a = (await r.json()) as { id: string };
      expect(await env.DB.prepare("SELECT anfrage_id, geparkt_id FROM email_anhaenge").first()).toEqual({ anfrage_id: a.id, geparkt_id: null });
      expect(await env.DB.prepare("SELECT anfrage_id, geparkt_id FROM email_eingang").first()).toEqual({ anfrage_id: a.id, geparkt_id: null });
    });
  });
});
