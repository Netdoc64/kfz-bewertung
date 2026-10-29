import { Hono } from "hono";
import { AnlegenSchema, legeAn } from "../anfragen/index.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

/** Öffentliches Formular: legt Anfragen an, ohne Anmeldung. */
export const formularRouten = new Hono<AppUmgebung>().post("/", async (c) => {
  const roh: unknown = await c.req.json().catch(() => {
    throw new AppFehler("EINGABE_UNGUELTIG", "Kein gültiges JSON");
  });
  const p = AnlegenSchema.safeParse(roh);
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });

  const r = await legeAn(
    { db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL },
    p.data,
    { kanal: "formular", wer: "system", korrelation: c.get("korrelationsId") },
  );
  // Nach außen nur das Nötigste; ein geparkter Eingang sieht für den Absender wie angenommen aus.
  return c.json({ id: r.id, status: r.status }, r.geparkt ? 202 : 201);
});
