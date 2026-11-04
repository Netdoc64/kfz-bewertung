import { Hono } from "hono";
import { adminPflicht } from "../auth/access.js";
import type { AppUmgebung } from "../env.js";
import { fehlerBehandlung, grundlage, nichtGefunden } from "../fehler/middleware.js";

/** Pfade, die der API-Router besitzt; alles andere gehört dem Admin-Web. */
const API_PRAEFIXE = ["/api/", "/webhook/"];

export function istAdminAssetPfad(pfad: string): boolean {
  return !API_PRAEFIXE.some((p) => pfad.startsWith(p)) && pfad !== "/api" && pfad !== "/webhook";
}

// Die API-Kopfzeilen (CSP default-src 'none') würden die Seite leerlaufen lassen; die Seite braucht
// eigene Skripte und Stile vom selben Ursprung, sonst bleibt sie so streng wie die API.
const KOPFZEILEN: Array<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Cache-Control", "no-store"],
  [
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  ],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
];

/**
 * Admin-Web als statische Assets des Workers. Der Worker läuft zuerst (`run_worker_first`), die
 * Access-Prüfung greift also vor jeder Auslieferung; das ASSETS-Binding liefert erst danach.
 */
export const adminAssets = new Hono<AppUmgebung>()
  .use("*", grundlage)
  .use("*", async (c, next) => {
    await next();
    for (const [name, wert] of KOPFZEILEN) c.res.headers.set(name, wert);
  })
  .use("*", adminPflicht)
  .on(["GET", "HEAD"], "*", (c) => {
    // Ohne gebautes Admin-Web (Umgebung entwicklung) gibt es kein Binding: nichts auszuliefern.
    if (!c.env.ASSETS) return c.notFound();
    return c.env.ASSETS.fetch(c.req.raw);
  });

adminAssets.onError(fehlerBehandlung);
adminAssets.notFound(nichtGefunden);
