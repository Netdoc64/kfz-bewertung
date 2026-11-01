import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppUmgebung } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";

/** Cloudflare Access signiert mit RS256; alles andere wird abgewiesen. */
const ALGORITHMUS = "RS256";

const jwksJeTeam = new Map<string, JWTVerifyGetKey>();

function jwks(team: string): JWTVerifyGetKey {
  let s = jwksJeTeam.get(team);
  if (!s) {
    s = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksJeTeam.set(team, s);
  }
  return s;
}

/**
 * Admin-Bereich hinter Cloudflare Access. Das JWT wird selbst geprüft — der
 * Header allein reicht nicht, falls der Worker einmal ohne Access erreichbar ist.
 */
export const adminPflicht: MiddlewareHandler<AppUmgebung> = async (c, next) => {
  if (c.env.UMGEBUNG === "entwicklung") {
    c.set("admin", "entwicklung@lokal");
    return next();
  }
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  if (!team || !aud) {
    throw new AppFehler("INTERN", "Cloudflare Access ist nicht konfiguriert (ACCESS_TEAM_DOMAIN/ACCESS_AUD)");
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) throw new AppFehler("NICHT_ANGEMELDET");
  try {
    // Zuerst nur den Kopf lesen: andere Algorithmen als RS256 (none, HS256) kommen gar nicht erst zur Prüfung.
    if (decodeProtectedHeader(token).alg !== ALGORITHMUS) throw new AppFehler("NICHT_ANGEMELDET", "Access-Token mit unzulässigem Algorithmus");
    const { payload } = await jwtVerify(token, jwks(team), { issuer: `https://${team}`, audience: aud, algorithms: [ALGORITHMUS] });
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) throw new AppFehler("NICHT_ANGEMELDET", "Access-Token ohne E-Mail");
    c.set("admin", email);
  } catch (e) {
    if (e instanceof AppFehler) throw e;
    throw new AppFehler("NICHT_ANGEMELDET", "Access-Token ungültig", { ursache: e });
  }
  return next();
};
