import { Hono } from "hono";
import { adminPflicht } from "./auth/access.js";
import type { AppUmgebung } from "./env.js";
import { fehlerBehandlung, grundlage, nichtGefunden } from "./fehler/middleware.js";
import { verarbeiteEmail } from "./email/index.js";
import { fuehreCronAus } from "./cron/index.js";
import { verarbeiteQueue } from "./queue/index.js";
import { anfragenRouten } from "./routen/anfragen.js";
import { dsgvoRouten } from "./routen/dsgvo.js";
import { deadLetterRouten } from "./routen/dead-letter.js";
import { geparktRouten } from "./routen/geparkt.js";
import { formularRouten } from "./routen/formular.js";
import { kennzahlenRouten } from "./routen/kennzahlen.js";
import { einstellungenRouten } from "./routen/einstellungen.js";
import { fehlerRouten } from "./routen/fehler.js";
import { geraeteRouten } from "./routen/geraete.js";
import { appRouten } from "./routen/app.js";

export const app = new Hono<AppUmgebung>()
  .use("*", grundlage)
  .get("/api/gesundheit", async (c) => {
    // Prüft auch die Datenbank — ein grüner Haken ohne DB wäre gelogen.
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, umgebung: c.env.UMGEBUNG });
  })
  .route("/api/anfragen", formularRouten)
  .use("/api/admin/*", adminPflicht)
  .route("/api/admin/einstellungen", einstellungenRouten)
  .route("/api/admin/fehler", fehlerRouten)
  .route("/api/admin/anfragen", anfragenRouten)
  .route("/api/admin/geparkt", geparktRouten)
  .route("/api/admin/dead-letter", deadLetterRouten)
  .route("/api/admin/dsgvo", dsgvoRouten)
  .route("/api/admin/kennzahlen", kennzahlenRouten)
  .route("/api/admin/geraete", geraeteRouten)
  .route("/api/app", appRouten);

app.onError(fehlerBehandlung);
app.notFound(nichtGefunden);

export default {
  fetch: app.fetch,
  queue: (batch, env, ctx) => verarbeiteQueue(batch, env, ctx),
  scheduled: (controller, env, ctx) => fuehreCronAus(controller, env, ctx),
  email: (nachricht, env, ctx) => verarbeiteEmail(nachricht, env, ctx),
} satisfies ExportedHandler<AppUmgebung["Bindings"], unknown>;
