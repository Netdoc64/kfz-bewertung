import { Hono } from "hono";
import { z } from "zod";
import { geraetePflicht, koppeln, type GeraeteUmgebung } from "../geraete/index.js";
import { aktionHandler, detailHandler, listeHandler, type HandlerKontext } from "./anfragen.js";
import { AppFehler } from "../fehler/app-fehler.js";

const PushTokenSchema = z.object({ token: z.string().trim().min(1).max(4096) });
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
  .use("*", geraetePflicht)
  // Das Gerät meldet sein FCM-Token; es gilt nur für das Gerät des Geräte-Tokens.
  .post("/push-token", async (c) => {
    const p = PushTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Push-Token erforderlich", { details: p.error.issues });
    await c.env.DB.prepare("UPDATE geraete SET push_token = ?2 WHERE id = ?1").bind(c.get("geraet"), p.data.token).run();
    return c.json({ ok: true });
  })
  // Dieselben Dienstfunktionen wie /api/admin/anfragen, nur mit Kanal "app" und der Gerätekennung als „wer".
  .get("/", (c) => listeHandler(c as unknown as HandlerKontext))
  .get("/:id", (c) => detailHandler(c as unknown as HandlerKontext))
  .post("/:id/aktion", (c) => aktionHandler(c as unknown as HandlerKontext, "app"));
