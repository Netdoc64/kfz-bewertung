import { istEinstellungsSchluessel } from "@kfz/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

const SetzenSchema = z.object({
  /** `null` setzt auf den Standardwert zurück. */
  wert: z.unknown(),
  version: z.number().int().nonnegative(),
});

function schluessel(s: string) {
  if (!istEinstellungsSchluessel(s)) throw new AppFehler("EINSTELLUNG_UNBEKANNT", `Einstellung ${s} gibt es nicht`);
  return s;
}

async function json(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AppFehler("EINGABE_UNGUELTIG", "Kein gültiges JSON");
  }
}

export const einstellungenRouten = new Hono<AppUmgebung>()
  .get("/", async (c) => {
    const e = c.get("einstellungen");
    const [eintraege, { abdruck }] = await Promise.all([e.alle(), e.abdruck()]);
    return c.json({ abdruck, eintraege });
  })
  .get("/:schluessel", async (c) => {
    return c.json(await c.get("einstellungen").eintrag(schluessel(c.req.param("schluessel"))));
  })
  .get("/:schluessel/verlauf", async (c) => {
    const k = schluessel(c.req.param("schluessel"));
    return c.json({ verlauf: await c.get("einstellungen").verlauf(k, 50) });
  })
  .put("/:schluessel", async (c) => {
    const k = schluessel(c.req.param("schluessel"));
    const p = SetzenSchema.safeParse(await json(c.req.raw));
    if (!p.success || !("wert" in (p.data ?? {}))) {
      throw new AppFehler("EINGABE_UNGUELTIG", "Erwartet { wert, version }", { details: p.success ? undefined : p.error.issues });
    }
    const eintrag = await c.get("einstellungen").setze(k, p.data.wert ?? null, p.data.version, c.get("admin"));
    return c.json(eintrag);
  });
