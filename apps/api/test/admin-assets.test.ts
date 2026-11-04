import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";

const TEAM = "kfz-assets.cloudflareaccess.com";
const AUD = "aud-assets-123";
const SEITE = "<!doctype html><title>admin</title>";
const angefragt: string[] = [];
const assets = {
  fetch: async (r: Request) => {
    angefragt.push(new URL(r.url).pathname);
    return new Response(SEITE, { headers: { "content-type": "text/html" } });
  },
} as unknown as Fetcher;
const prod = { ...env, UMGEBUNG: "produktion" as const, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ASSETS: assets };
const rufe = (pfad: string, token?: string, e: object = prod) =>
  worker.fetch!(new Request(`http://lokal${pfad}`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} }) as never, e as typeof env, { waitUntil() {}, passThroughOnException() {} } as never);

let privat: CryptoKey;
const echterFetch = globalThis.fetch;

beforeAll(async () => {
  const k = await generateKeyPair("RS256", { extractable: true });
  privat = k.privateKey;
  const jwk = { ...(await exportJWK(k.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  globalThis.fetch = (async (u: RequestInfo | URL, i?: RequestInit) => {
    if (String(u).includes(`${TEAM}/cdn-cgi/access/certs`)) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    return echterFetch(u, i);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = echterFetch;
});

const token = () =>
  new SignJWT({ email: "chef@example.de" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(privat);

describe("Admin-Web als Assets hinter Access", () => {
  it.each(["/", "/index.html", "/assets/main.js"])("%s ohne JWT → 401, Asset nie angefragt", async (pfad) => {
    angefragt.length = 0;
    const r = await rufe(pfad);
    expect(r.status).toBe(401);
    expect(angefragt).toEqual([]);
  });

  it("mit gültigem JWT → Seite aus dem ASSETS-Binding, mit eigener CSP", async () => {
    angefragt.length = 0;
    const r = await rufe("/", await token());
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(SEITE);
    expect(angefragt).toEqual(["/"]);
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("Produktion ohne Access-Konfiguration verweigert die Seite (fail closed)", async () => {
    angefragt.length = 0;
    const r = await rufe("/", await token(), { ...prod, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" });
    expect(r.status).toBe(500);
    expect(angefragt).toEqual([]);
  });

  it("ohne ASSETS-Binding (lokal) → 404 statt Absturz", async () => {
    const r = await rufe("/", undefined, { ...env, ASSETS: undefined });
    expect(r.status).toBe(404);
  });

  it("/api/* bleibt unverändert: strenge CSP, Admin-Route verlangt weiter ein JWT, kein Asset-Zugriff", async () => {
    angefragt.length = 0;
    const g = await rufe("/api/gesundheit");
    expect(g.status).toBe(200);
    expect(g.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect((await rufe("/api/admin/geraete")).status).toBe(401);
    expect((await rufe("/api/gibtsnicht")).status).toBe(404);
    expect(angefragt).toEqual([]);
  });
});
