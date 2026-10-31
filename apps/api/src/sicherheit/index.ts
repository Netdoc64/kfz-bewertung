import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppUmgebung } from "../env.js";
import { fehlerBehandlung } from "../fehler/middleware.js";
import { AppFehler } from "../fehler/app-fehler.js";

const KOPFZEILEN: Array<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Cache-Control", "no-store"],
  ["Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
];

/**
 * Sicherheits-Header für jede Antwort. Die API liefert nur JSON und Downloads: nichts davon
 * darf eingebettet, gecacht oder als Seite ausgeführt werden. Eine CORS-Freigabe gibt es bewusst
 * nicht — Admin-Web und App rufen die API vom selben Ursprung bzw. nativ auf.
 */
export const sicherheitsKopfzeilen: MiddlewareHandler<AppUmgebung> = async (c, next) => {
  await next();
  // Nach dem Handler setzen: das gilt auch für Antworten, die ein Handler selbst als Response baut (Downloads).
  for (const [name, wert] of KOPFZEILEN) c.res.headers.set(name, wert);
};

/** Begrenzt die Body-Größe aller Schreibaufrufe; die Grenze kommt zur Laufzeit aus der Registry. */
export const bodyBegrenzung: MiddlewareHandler<AppUmgebung> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  const maxSize = await c.get("einstellungen").lese("sicherheit.bodyMaxBytes");
  return bodyLimit({ maxSize, onError: (ctx) => fehlerBehandlung(new AppFehler("ANFRAGE_ZU_GROSS"), ctx as never) })(c, next);
};
