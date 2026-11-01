import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index.js";

const TEAM = "kfz-test.cloudflareaccess.com";
const AUD = "aud-test-123";
const prod = { ...env, UMGEBUNG: "produktion" as const, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const admin = (pfad: string, token?: string, e: object = prod, init: RequestInit = {}) =>
  app.request(`http://lokal${pfad}`, { ...init, headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), ...(init.headers as object) } }, e as typeof env);
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;

let privat: CryptoKey;
let fremd: CryptoKey;
const echterFetch = globalThis.fetch;

beforeAll(async () => {
  const k = await generateKeyPair("RS256", { extractable: true });
  privat = k.privateKey;
  fremd = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(k.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  globalThis.fetch = (async (u: RequestInfo | URL, i?: RequestInit) => {
    if (String(u).includes(`${TEAM}/cdn-cgi/access/certs`)) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    return echterFetch(u, i);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = echterFetch;
});

const token = (opt: { key?: CryptoKey; aud?: string; iss?: string; exp?: string | number; email?: string | null } = {}) =>
  new SignJWT(opt.email === null ? {} : { email: opt.email ?? "chef@example.de" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opt.iss ?? `https://${TEAM}`)
    .setAudience(opt.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opt.exp ?? "5m")
    .sign(opt.key ?? privat);

describe("A02 Broken Authentication: Access-JWT", () => {
  it("gültiges Token → Zugang", async () => {
    expect((await admin("/api/admin/geraete", await token())).status).toBe(200);
  });

  it("ohne Token → 401 NICHT_ANGEMELDET", async () => {
    const r = await admin("/api/admin/geraete");
    expect(r.status).toBe(401);
    expect(await code(r)).toBe("NICHT_ANGEMELDET");
  });

  it.each([
    ["fremder Schlüssel", () => token({ key: fremd })],
    ["falsche Audience", () => token({ aud: "andere" })],
    ["falscher Aussteller", () => token({ iss: "https://boese.example" })],
    ["abgelaufen", () => token({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["ohne E-Mail", () => token({ email: null })],
    ["Müll", async () => "kein.jwt.token"],
  ])("%s → 401", async (_n, mach) => {
    const r = await admin("/api/admin/geraete", await mach());
    expect(r.status).toBe(401);
    expect(await code(r)).toBe("NICHT_ANGEMELDET");
  });

  it("alg=none und HS256 werden abgewiesen (Algorithmus-Verwechslung)", async () => {
    const b64 = (s: string) => btoa(s).replace(/=/g, "");
    const none = `${b64('{"alg":"none","kid":"k1"}')}.${b64(JSON.stringify({ email: "x@y.de", iss: `https://${TEAM}`, aud: AUD, exp: 9999999999 }))}.`;
    expect((await admin("/api/admin/geraete", none)).status).toBe(401);
    const hs = await new SignJWT({ email: "x@y.de" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("geheim-geheim-geheim-geheim-geheim"));
    expect((await admin("/api/admin/geraete", hs)).status).toBe(401);
  });

  it("Produktion ohne Access-Konfiguration verweigert den Admin-Bereich (fail closed), ohne Interna zu nennen", async () => {
    const r = await admin("/api/admin/geraete", await token(), { ...prod, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("ACCESS_");
  });

  it("jede Admin-Route verlangt in Produktion ein Token (BFLA/Inventar)", async () => {
    const routen: Array<[string, string]> = [
      ["GET", "/api/admin/einstellungen"], ["PUT", "/api/admin/einstellungen/ablauf.autopilot"], ["GET", "/api/admin/fehler"],
      ["GET", "/api/admin/anfragen"], ["POST", "/api/admin/anfragen"], ["POST", "/api/admin/anfragen/x/aktion"], ["POST", "/api/admin/anfragen/x/nachrichten"],
      ["GET", "/api/admin/geparkt"], ["GET", "/api/admin/geparkt/x/anhaenge/y"], ["POST", "/api/admin/geparkt/x/freigeben"],
      ["GET", "/api/admin/dead-letter"], ["POST", "/api/admin/dead-letter/1/erneut"], ["POST", "/api/admin/dsgvo/auskunft"], ["POST", "/api/admin/dsgvo/loeschung"],
      ["GET", "/api/admin/kennzahlen"], ["GET", "/api/admin/geraete"], ["POST", "/api/admin/geraete/kopplungscode"], ["POST", "/api/admin/geraete/x/widerrufen"],
      ["GET", "/api/admin/unbekannt"],
    ];
    for (const [m, p] of routen) expect((await admin(p, undefined, prod, { method: m })).status, `${m} ${p}`).toBe(401);
  });

  it("ein Geräte-Token öffnet den Admin-Bereich nicht (BFLA)", async () => {
    const r = await admin("/api/admin/einstellungen", undefined, prod, { headers: { authorization: "Bearer " + "a".repeat(64) } });
    expect(r.status).toBe(401);
  });
});
