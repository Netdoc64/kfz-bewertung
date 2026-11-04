import { Hono } from "hono";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

/**
 * Öffentliche Gesundheitsroute für Rauchtest und Überwachung. Enthält nur
 * Zustände und Betriebsschalter — keine Personendaten, keine Geheimnisse,
 * keine Zählungen einzelner Anfragen.
 */
export const gesundRouten = new Hono<AppUmgebung>().get("/", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (e) {
    throw new AppFehler("DATENBANK", "Gesundheitsprüfung: D1 nicht erreichbar", { ursache: e });
  }
  const einst = c.get("einstellungen");
  const { abdruck, versionen } = await einst.abdruck();
  // Nur das Binding prüfen — es wird bewusst keine Nachricht eingereiht.
  const queueDa = typeof c.env.BEWERTUNG_QUEUE?.send === "function";
  return c.json({
    ok: queueDa,
    umgebung: c.env.UMGEBUNG,
    d1: "ok",
    queue: queueDa ? "bereit" : "fehlt",
    einstellungen: { abdruck, gespeicherteSchluessel: Object.values(versionen).filter((v) => v > 0).length },
    autopilot: await einst.lese("ablauf.autopilot"),
    quelleModus: await einst.lese("quelle.mobilede.modus"),
  });
});
