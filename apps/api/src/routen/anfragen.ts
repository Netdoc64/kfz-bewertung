import { Hono, type Context } from "hono";
import { AktionSchema, AnhaengenSchema, AnlegenSchema, ListeSchema, detailAnfrage, fuehreAktionAus, haengeAn, legeAn, listeAnfragen, type AnfrageUmgebung } from "../anfragen/index.js";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

async function json(req: Request): Promise<unknown> {
  return req.json().catch(() => {
    throw new AppFehler("EINGABE_UNGUELTIG", "Kein gültiges JSON");
  });
}

const umgebung = (c: Context<AppUmgebung>): AnfrageUmgebung => ({ db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL });

export const anfragenRouten = new Hono<AppUmgebung>()
  .get("/", async (c) => {
    const p = ListeSchema.safeParse(c.req.query());
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
    return c.json(await listeAnfragen(umgebung(c), p.data));
  })
  .get("/:id", async (c) => c.json(await detailAnfrage(umgebung(c), c.req.param("id"), c.env.BERICHTE)))
  .post("/:id/aktion", async (c) => {
    const p = AktionSchema.safeParse(await json(c.req.raw));
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
    const k = { kanal: "admin" as const, wer: c.get("admin"), korrelation: c.get("korrelationsId") };
    return c.json(await fuehreAktionAus(umgebung(c), c.req.param("id"), p.data, k, c.env.BERICHTE));
  })
  .post("/", async (c) => {
    const p = AnlegenSchema.safeParse(await json(c.req.raw));
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
    const u: AnfrageUmgebung = { db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL };
    const r = await legeAn(u, p.data, { kanal: "admin", wer: c.get("admin"), korrelation: c.get("korrelationsId") });
    return c.json(r, 201);
  })
  .post("/:id/nachrichten", async (c) => {
    const roh = await json(c.req.raw);
    const p = AnhaengenSchema.safeParse(roh);
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", undefined, { details: p.error.issues });
    const u: AnfrageUmgebung = { db: c.env.DB, einstellungen: c.get("einstellungen"), queue: c.env.BEWERTUNG_QUEUE, email: c.env.EMAIL };
    const fahrzeugRoh = (roh as { fahrzeug?: object }).fahrzeug;
    const r = await haengeAn(u, c.req.param("id"), p.data, { kanal: "admin", wer: c.get("admin"), korrelation: c.get("korrelationsId") }, fahrzeugRoh);
    return c.json(r);
  });
