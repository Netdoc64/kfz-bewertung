import { Hono } from "hono";
import type { BewertungsJob } from "../anfragen/index.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

interface Zeile {
  id: number;
  nachricht_id: string;
  queue: string;
  anfrage_id: string | null;
  job_generation: number | null;
  korrelation: string | null;
  nutzlast: string;
  versuche: number;
  erstellt_am: string;
  erneut_am: string | null;
  erneut_von: string | null;
  erneut_generation: number | null;
}

const SPALTEN = "id, nachricht_id, queue, anfrage_id, job_generation, korrelation, nutzlast, versuche, erstellt_am, erneut_am, erneut_von, erneut_generation";

function ansicht(z: Zeile) {
  let nutzlast: unknown = null;
  try {
    nutzlast = JSON.parse(z.nutzlast);
  } catch {
    // Beschädigte Nutzlast bleibt sichtbar als Null.
  }
  return { ...z, nutzlast };
}

async function lade(db: D1Database, idText: string): Promise<Zeile> {
  const id = Number(idText);
  if (!Number.isInteger(id)) throw new AppFehler("NICHT_GEFUNDEN");
  const z = await db.prepare(`SELECT ${SPALTEN} FROM dead_letter WHERE id = ?1`).bind(id).first<Zeile>();
  if (!z) throw new AppFehler("NICHT_GEFUNDEN");
  return z;
}

/** Admin-Ansicht der endgültig fehlgeschlagenen Jobs: listen und erneut einreihen. */
export const deadLetterRouten = new Hono<AppUmgebung>()
  // ?alle=1 zeigt auch bereits erneut eingereihte; sonst nur offene.
  .get("/", async (c) => {
    const alle = c.req.query("alle") === "1";
    const { results } = await c.env.DB.prepare(
      `SELECT ${SPALTEN} FROM dead_letter ${alle ? "" : "WHERE erneut_am IS NULL"} ORDER BY erstellt_am DESC, id DESC LIMIT 200`,
    ).all<Zeile>();
    return c.json({ eintraege: results.map(ansicht) });
  })
  .get("/:id", async (c) => c.json(ansicht(await lade(c.env.DB, c.req.param("id")))))
  // Neue Generation und neuer Job. Idempotent: ein schon eingereihter Eintrag liefert sein Ergebnis, ohne erneut zu senden.
  .post("/:id/erneut", async (c) => {
    const z = await lade(c.env.DB, c.req.param("id"));
    if (z.erneut_am) return c.json({ ...ansicht(z), bereitsEingereiht: true });
    if (!z.anfrage_id) throw new AppFehler("EINGABE_UNGUELTIG", "Der Eintrag gehört zu keiner Anfrage");

    // Zuerst beanspruchen, damit zwei gleichzeitige Klicks nur einen Job erzeugen.
    const claim = await c.env.DB.prepare(
      "UPDATE dead_letter SET erneut_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), erneut_von = ?2 WHERE id = ?1 AND erneut_am IS NULL",
    )
      .bind(z.id, c.get("admin"))
      .run();
    if (claim.meta.changes === 0) return c.json({ ...ansicht(await lade(c.env.DB, c.req.param("id"))), bereitsEingereiht: true });

    try {
      const a = await c.env.DB.prepare(
        "UPDATE anfragen SET generation = generation + 1, version = version + 1, geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1 RETURNING generation",
      )
        .bind(z.anfrage_id)
        .first<{ generation: number }>();
      if (!a) throw new AppFehler("NICHT_GEFUNDEN", "Die Anfrage zum Eintrag existiert nicht mehr");
      const job: BewertungsJob = { art: "bewertung", anfrageId: z.anfrage_id, generation: a.generation, korrelation: c.get("korrelationsId") };
      await c.env.BEWERTUNG_QUEUE.send(job);
      await c.env.DB.prepare("UPDATE dead_letter SET erneut_generation = ?2 WHERE id = ?1").bind(z.id, a.generation).run();
    } catch (e) {
      await c.env.DB.prepare("UPDATE dead_letter SET erneut_am = NULL, erneut_von = NULL, erneut_generation = NULL WHERE id = ?1").bind(z.id).run().catch(() => {});
      throw e;
    }
    return c.json({ ...ansicht(await lade(c.env.DB, c.req.param("id"))), bereitsEingereiht: false });
  });
