import { Hono } from "hono";
import { AnlegenSchema, legeAn, type AnfrageUmgebung } from "../anfragen/index.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

interface Zeile {
  id: string;
  kontakt: string;
  kanal: string;
  nutzlast: string;
  grund: string;
  korrelation: string;
  erstellt_am: string;
  geprueft_am: string | null;
  geprueft_von: string | null;
  entscheidung: "freigegeben" | "verworfen" | null;
  anfrage_id: string | null;
}

const SPALTEN = "id, kontakt, kanal, nutzlast, grund, korrelation, erstellt_am, geprueft_am, geprueft_von, entscheidung, anfrage_id";

async function lade(db: D1Database, id: string): Promise<Zeile> {
  const z = await db.prepare(`SELECT ${SPALTEN} FROM eingang_geparkt WHERE id = ?1`).bind(id).first<Zeile>();
  if (!z) throw new AppFehler("NICHT_GEFUNDEN");
  return z;
}

const offenPflicht = (z: Zeile) => {
  if (z.entscheidung) throw new AppFehler("STATUSWECHSEL_UNZULAESSIG", "Dieser Eingang ist bereits entschieden", { kontext: { entscheidung: z.entscheidung } });
};

interface AnhangZeile {
  id: string;
  dateiname: string | null;
  medientyp: string;
  groesse: number;
  erstellt_am: string;
}

async function anhaenge(db: D1Database, geparktId: string): Promise<AnhangZeile[]> {
  const { results } = await db
    .prepare("SELECT id, dateiname, medientyp, groesse, erstellt_am FROM email_anhaenge WHERE geparkt_id = ?1 ORDER BY erstellt_am, id")
    .bind(geparktId)
    .all<AnhangZeile>();
  return results;
}

/** Freigabe eines Mail-Eingangs: Fahrzeugangaben (und ggf. Name/Kennzeichen) kommen vom Admin, der Rest aus der Mail. */
const MailFreigabeSchema = AnlegenSchema.pick({ name: true, fahrzeug: true, kennzeichen: true }).partial({ name: true });

function ansicht(z: Zeile) {
  let nutzlast: unknown = null;
  try {
    nutzlast = JSON.parse(z.nutzlast);
  } catch {
    // Beschädigte Nutzlast bleibt sichtbar als Null; Freigabe scheitert dann an der Prüfung.
  }
  return { ...z, nutzlast };
}

/** Admin-Ansicht der vom Flutschutz geparkten Eingänge: listen, prüfen, freigeben, verwerfen. */
export const geparktRouten = new Hono<AppUmgebung>()
  // ?alle=1 zeigt auch entschiedene; sonst nur offene. ?ungeprueft=1 nur offene ohne Geprüft-Kennzeichen.
  .get("/", async (c) => {
    const alle = c.req.query("alle") === "1";
    const ungeprueft = c.req.query("ungeprueft") === "1";
    const bedingung = alle ? "1 = 1" : ungeprueft ? "entscheidung IS NULL AND geprueft_am IS NULL" : "entscheidung IS NULL";
    const { results } = await c.env.DB.prepare(`SELECT ${SPALTEN} FROM eingang_geparkt WHERE ${bedingung} ORDER BY erstellt_am DESC LIMIT 200`).all<Zeile>();
    return c.json({ eintraege: results.map(ansicht) });
  })
  .get("/:id", async (c) => {
    const z = await lade(c.env.DB, c.req.param("id"));
    return c.json({ ...ansicht(z), anhaenge: await anhaenge(c.env.DB, z.id) });
  })
  // Anhang aus R2 ausliefern (z. B. Fahrzeugschein-Foto); nur zu einem Eingang, nie roh per Schlüssel.
  .get("/:id/anhaenge/:anhangId", async (c) => {
    const a = await c.env.DB.prepare("SELECT r2_schluessel, dateiname, medientyp FROM email_anhaenge WHERE id = ?2 AND geparkt_id = ?1")
      .bind(c.req.param("id"), c.req.param("anhangId"))
      .first<{ r2_schluessel: string; dateiname: string | null; medientyp: string }>();
    if (!a) throw new AppFehler("NICHT_GEFUNDEN");
    const o = await c.env.BERICHTE.get(a.r2_schluessel);
    if (!o) throw new AppFehler("NICHT_GEFUNDEN");
    const name = encodeURIComponent(a.dateiname ?? "anhang");
    return new Response(o.body, {
      headers: { "content-type": a.medientyp, "content-disposition": `attachment; filename*=UTF-8''${name}`, "x-content-type-options": "nosniff" },
    });
  })
  // Geprüft-Kennzeichen setzen, ohne zu entscheiden.
  .post("/:id/pruefen", async (c) => {
    const z = await lade(c.env.DB, c.req.param("id"));
    offenPflicht(z);
    await c.env.DB.prepare("UPDATE eingang_geparkt SET geprueft_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), geprueft_von = ?2 WHERE id = ?1 AND entscheidung IS NULL")
      .bind(z.id, c.get("admin"))
      .run();
    return c.json(ansicht(await lade(c.env.DB, z.id)));
  })
  // Freigabe legt die Anfrage regulär an (Admin-Weg, vom Flutschutz ausgenommen).
  .post("/:id/freigeben", async (c) => {
    const z = await lade(c.env.DB, c.req.param("id"));
    offenPflicht(z);
    const nutzlast = ansicht(z).nutzlast;
    let kandidat = nutzlast;
    if (z.grund === "mail_unklar") {
      // Die Mail trägt keine Fahrzeugangaben; der Admin ergänzt sie beim Freigeben.
      const roh = await c.req.json().catch(() => ({}));
      const m = MailFreigabeSchema.safeParse(roh);
      if (!m.success) throw new AppFehler("EINGABE_UNGUELTIG", "Fahrzeugangaben fehlen oder sind ungültig", { details: m.error.issues });
      const n = (nutzlast ?? {}) as { name?: string; betreff?: string; text?: string };
      const nachricht = [n.betreff, n.text].filter(Boolean).join("\n\n").slice(0, 5000) || undefined;
      kandidat = { name: m.data.name ?? n.name, kontakt: z.kontakt, fahrzeug: m.data.fahrzeug, kennzeichen: m.data.kennzeichen, nachricht };
    }
    const p = AnlegenSchema.safeParse(kandidat);
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Gespeicherte Eingabe ist nicht mehr gültig", { details: p.error.issues });
    // Zuerst beanspruchen, damit zwei gleichzeitige Freigaben nur eine Anfrage erzeugen.
    const claim = await c.env.DB.prepare(
      "UPDATE eingang_geparkt SET entscheidung = 'freigegeben', geprueft_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), geprueft_von = ?2 WHERE id = ?1 AND entscheidung IS NULL",
    )
      .bind(z.id, c.get("admin"))
      .run();
    if (claim.meta.changes === 0) throw new AppFehler("VERSION_KONFLIKT");
    const u: AnfrageUmgebung = { db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL };
    try {
      const r = await legeAn(u, p.data, { kanal: "admin", wer: c.get("admin"), korrelation: c.get("korrelationsId") });
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE eingang_geparkt SET anfrage_id = ?2 WHERE id = ?1").bind(z.id, r.id),
        // Anhänge und Mail-Zuordnung wandern mit: Antworten auf die Mail finden die Anfrage.
        c.env.DB.prepare("UPDATE email_anhaenge SET anfrage_id = ?2, geparkt_id = NULL WHERE geparkt_id = ?1").bind(z.id, r.id),
        c.env.DB.prepare("UPDATE email_eingang SET anfrage_id = ?2, geparkt_id = NULL WHERE geparkt_id = ?1").bind(z.id, r.id),
      ]);
      return c.json(r, 201);
    } catch (e) {
      await c.env.DB.prepare("UPDATE eingang_geparkt SET entscheidung = NULL WHERE id = ?1").bind(z.id).run();
      throw e;
    }
  })
  .post("/:id/verwerfen", async (c) => {
    const z = await lade(c.env.DB, c.req.param("id"));
    offenPflicht(z);
    await c.env.DB.prepare(
      "UPDATE eingang_geparkt SET entscheidung = 'verworfen', geprueft_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), geprueft_von = ?2 WHERE id = ?1 AND entscheidung IS NULL",
    )
      .bind(z.id, c.get("admin"))
      .run();
    return c.json(ansicht(await lade(c.env.DB, z.id)));
  });
