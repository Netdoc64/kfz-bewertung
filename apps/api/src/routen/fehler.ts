import { SCHWERE_RANG, type Schwere } from "@kfz/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

export const FilterSchema = z.object({
  offen: z.enum(["ja", "nein", "alle"]).default("ja"),
  abSchwere: z.enum(["info", "warnung", "fehler", "kritisch"]).default("info"),
  grenze: z.coerce.number().int().min(1).max(200).default(50),
});

interface Zeile {
  id: number;
  code: string;
  schwere: Schwere;
  ort: string;
  nachricht: string;
  kontext: string | null;
  letzte_korrelation: string;
  anzahl: number;
  erstmals: string;
  zuletzt: string;
  quittiert_am: string | null;
  quittiert_von: string | null;
}

export const fehlerRouten = new Hono<AppUmgebung>()
  .get("/", async (c) => {
    const p = FilterSchema.safeParse(c.req.query());
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Ungültiger Filter", { details: p.error.issues });
    const { offen, abSchwere, grenze } = p.data;
    const schweren = (Object.keys(SCHWERE_RANG) as Schwere[]).filter((s) => SCHWERE_RANG[s] >= SCHWERE_RANG[abSchwere]);
    const offenSql = offen === "ja" ? "AND quittiert_am IS NULL" : offen === "nein" ? "AND quittiert_am IS NOT NULL" : "";
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM fehler_ereignisse
       WHERE schwere IN (${schweren.map(() => "?").join(",")}) ${offenSql}
       ORDER BY zuletzt DESC LIMIT ?`,
    )
      .bind(...schweren, grenze)
      .all<Zeile>();
    return c.json({
      fehler: results.map((z) => ({
        id: z.id,
        code: z.code,
        schwere: z.schwere,
        ort: z.ort,
        nachricht: z.nachricht,
        kontext: z.kontext ? JSON.parse(z.kontext) : null,
        letzteKorrelation: z.letzte_korrelation,
        anzahl: z.anzahl,
        erstmals: z.erstmals,
        zuletzt: z.zuletzt,
        quittiertAm: z.quittiert_am,
        quittiertVon: z.quittiert_von,
      })),
    });
  })
  .post("/:id/quittieren", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new AppFehler("EINGABE_UNGUELTIG", "Ungültige ID");
    const r = await c.env.DB.prepare(
      "UPDATE fehler_ereignisse SET quittiert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), quittiert_von = ?2 WHERE id = ?1 AND quittiert_am IS NULL",
    )
      .bind(id, c.get("admin"))
      .run();
    if (r.meta.changes !== 1) throw new AppFehler("NICHT_GEFUNDEN", "Fehler nicht gefunden oder schon quittiert");
    return c.json({ ok: true });
  });
