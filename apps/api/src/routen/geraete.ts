import { Hono } from "hono";
import { erzeugeKopplungscode, listeGeraete, widerrufe } from "../geraete/index.js";
import type { AppUmgebung } from "../env.js";

/** Admin-Verwaltung der App-Geräte (hinter adminPflicht). Das Gerät selbst entsteht beim Koppeln. */
export const geraeteRouten = new Hono<AppUmgebung>()
  .get("/", async (c) => c.json({ geraete: await listeGeraete(c.env.DB) }))
  // Der Code wird nur in dieser Antwort im Klartext gezeigt.
  .post("/kopplungscode", async (c) => c.json(await erzeugeKopplungscode(c.env.DB, c.get("einstellungen"), c.get("admin")), 201))
  .post("/:id/widerrufen", async (c) => {
    await widerrufe(c.env.DB, c.req.param("id"));
    return c.json({ ok: true });
  });
