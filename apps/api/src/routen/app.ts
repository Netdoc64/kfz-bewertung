import { Hono } from "hono";
import { z } from "zod";
import { geraetePflicht, koppeln, type GeraeteUmgebung } from "../geraete/index.js";
import { AppFehler } from "../fehler/app-fehler.js";

const KoppelnSchema = z.object({ code: z.string().min(1).max(64), name: z.string().trim().min(1).max(80) });

/**
 * App-API. `/koppeln` ist öffentlich (der Code ist der Nachweis); alles, was danach
 * registriert wird, verlangt ein gültiges Geräte-Token. Folgethemen hängen ihre Routen UNTER die Middleware.
 */
export const appRouten = new Hono<GeraeteUmgebung>()
  .post("/koppeln", async (c) => {
    const p = KoppelnSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Code und Gerätename erforderlich", { details: p.error.issues });
    return c.json(await koppeln(c.env.DB, c.get("einstellungen"), p.data.code, p.data.name), 201);
  })
  .use("*", geraetePflicht);
