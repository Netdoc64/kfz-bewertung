import { Hono } from "hono";
import { z } from "zod";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { ladeKennzahlen } from "../kennzahlen/index.js";

const TAG_MS = 86_400_000;
const ZeitSchema = z.string().datetime({ offset: true });
const FilterSchema = z.object({ von: ZeitSchema.optional(), bis: ZeitSchema.optional() });

/** Admin-Kennzahlen (A12). Zeitraum `?von=&bis=` (ISO); ohne Angabe die letzten `ablauf.kennzahlenZeitraumTage`. */
export const kennzahlenRouten = new Hono<AppUmgebung>().get("/", async (c) => {
  const p = FilterSchema.safeParse(c.req.query());
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Ungültiger Zeitraum", { details: p.error.issues });
  const einst = c.get("einstellungen");
  const bis = p.data.bis ? new Date(p.data.bis) : new Date();
  const von = p.data.von ? new Date(p.data.von) : new Date(bis.getTime() - (await einst.lese("ablauf.kennzahlenZeitraumTage")) * TAG_MS);
  if (!(von < bis)) throw new AppFehler("EINGABE_UNGUELTIG", "„von“ muss vor „bis“ liegen");
  const grenzen = await einst.lese("ablauf.kennzahlenKonfidenzGrenzen");
  return c.json(await ladeKennzahlen(c.env.DB, { von: von.toISOString(), bis: bis.toISOString() }, grenzen));
});
