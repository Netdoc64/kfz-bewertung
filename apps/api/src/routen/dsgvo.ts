import { ENDSTATUS } from "@kfz/shared";
import { Hono } from "hono";
import { z } from "zod";
import { findePerson, loeschePersonendaten, sammleAuskunft } from "../dsgvo/index.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

const KontaktSchema = z.object({ kontakt: z.string().trim().min(3).max(320) });
const LoeschSchema = KontaktSchema.extend({ bestaetigung: z.string().trim().min(3).max(320) });

function lies<T extends z.ZodType>(schema: T, daten: unknown): z.infer<T> {
  const p = schema.safeParse(daten);
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Kontakt fehlt oder ist ungültig", { details: p.error.issues });
  return p.data;
}

/**
 * DSGVO per Admin (Art. 15 und 17). Der Kontakt steht im Body, nicht in der URL: so landet er in keinem Zugriffsprotokoll.
 * Die Löschung verlangt die Wiederholung des Kontakts als Bestätigung.
 */
export const dsgvoRouten = new Hono<AppUmgebung>()
  .post("/auskunft", async (c) => {
    const { kontakt } = lies(KontaktSchema, await c.req.json().catch(() => null));
    const max = await c.get("einstellungen").lese("betrieb.dsgvoAuskunftMaxAnfragen");
    const bezug = await findePerson(c.env.DB, kontakt, max);
    if (bezug.anfrageIds.length === 0 && bezug.geparktIds.length === 0) throw new AppFehler("NICHT_GEFUNDEN", "Zu diesem Kontakt sind keine Daten gespeichert");
    return c.json({ abgeschnitten: bezug.abgeschnitten, ...(await sammleAuskunft(c.env.DB, kontakt, bezug)) });
  })
  .post("/loeschung", async (c) => {
    const { kontakt, bestaetigung } = lies(LoeschSchema, await c.req.json().catch(() => null));
    if (bestaetigung.toLowerCase() !== kontakt.toLowerCase()) throw new AppFehler("EINGABE_UNGUELTIG", "Die Bestätigung stimmt nicht mit dem Kontakt überein");
    const einst = c.get("einstellungen");
    const bezug = await findePerson(c.env.DB, kontakt, await einst.lese("betrieb.dsgvoAuskunftMaxAnfragen"));
    if (bezug.anfrageIds.length === 0 && bezug.geparktIds.length === 0) throw new AppFehler("NICHT_GEFUNDEN", "Zu diesem Kontakt sind keine Daten gespeichert");
    if (bezug.abgeschnitten) throw new AppFehler("EINGABE_UNGUELTIG", "Zu viele Datensätze für eine Löschung; bitte die Obergrenze in den Einstellungen prüfen");
    if ((await einst.lese("betrieb.dsgvoEinzelloeschungOffeneAnfragen")) === "sperren") {
      const stati = ENDSTATUS.map((_, i) => `?${i + 2}`).join(",");
      const offen = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM anfragen WHERE id IN (SELECT value FROM json_each(?1)) AND status NOT IN (${stati})`)
        .bind(JSON.stringify(bezug.anfrageIds), ...ENDSTATUS)
        .first<{ n: number }>();
      if (offen && offen.n > 0) throw new AppFehler("DSGVO_OFFENE_ANFRAGE", undefined, { kontext: { offeneAnfragen: offen.n } });
    }
    const ergebnis = await loeschePersonendaten(c.env.DB, c.env.BERICHTE, bezug, { durch: c.get("admin"), kontakt });
    return c.json({ geloescht: true, ...ergebnis });
  });
