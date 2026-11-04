import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { NachrichtSchema, pruefeWebhook, verarbeiteWhatsapp } from "../whatsapp/index.js";

const zuGross = () => {
  throw new AppFehler("ANFRAGE_ZU_GROSS");
};

/**
 * Webhook des Business Managers für eingehende WhatsApp-Nachrichten (docs/manager-webhook.md).
 * Kein Access-Login: der Nachweis ist die HMAC-Signatur über Zeitstempel und Rohkörper.
 * Liegt bewusst außerhalb von `/api/*`, weil dort die allgemeine Body-Grenze gilt; Bilder kommen base64 im Body.
 */
export const whatsappRouten = new Hono<AppUmgebung>().post(
  "/",
  async (c, next) => bodyLimit({ maxSize: await c.get("einstellungen").lese("webhook.manager.bodyMaxBytes"), onError: zuGross })(c, next),
  async (c) => {
    const einst = c.get("einstellungen");
    const koerper = await c.req.arrayBuffer();
    await pruefeWebhook({
      schluessel: c.env.WEBHOOK_HMAC_SCHLUESSEL,
      zeitstempel: c.req.header("X-Kfz-Zeitstempel"),
      signatur: c.req.header("X-Kfz-Signatur"),
      koerper,
      toleranzSekunden: await einst.lese("webhook.manager.toleranzSekunden"),
    });
    let roh: unknown = null;
    try {
      roh = JSON.parse(new TextDecoder().decode(koerper));
    } catch {
      // bleibt null und fällt unten auf EINGABE_UNGUELTIG
    }
    const p = NachrichtSchema.safeParse(roh);
    if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Nutzlast ungültig", { details: p.error.issues });
    return c.json({ ok: true, ...(await verarbeiteWhatsapp(c.env, einst, p.data, c.get("korrelationsId"))) });
  },
);
