import { Hono } from "hono";
import { adminPflicht } from "./auth/access.js";
import type { AppUmgebung } from "./env.js";
import { fehlerBehandlung, grundlage, nichtGefunden } from "./fehler/middleware.js";
import { einstellungenRouten } from "./routen/einstellungen.js";
import { fehlerRouten } from "./routen/fehler.js";

export const app = new Hono<AppUmgebung>()
  .use("*", grundlage)
  .get("/api/gesundheit", async (c) => {
    // Prüft auch die Datenbank — ein grüner Haken ohne DB wäre gelogen.
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, umgebung: c.env.UMGEBUNG });
  })
  .use("/api/admin/*", adminPflicht)
  .route("/api/admin/einstellungen", einstellungenRouten)
  .route("/api/admin/fehler", fehlerRouten);

app.onError(fehlerBehandlung);
app.notFound(nichtGefunden);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<AppUmgebung["Bindings"]>;
