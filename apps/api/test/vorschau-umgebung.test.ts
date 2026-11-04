import { env } from "cloudflare:test";
import { SignJWT, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";
import wranglerRoh from "../wrangler.jsonc?raw";

/** JSONC → JSON: Kommentare und Komma vor schließender Klammer entfernen, Zeichenketten bleiben unberührt. */
function jsonc(text: string): any {
  let aus = "";
  let i = 0;
  while (i < text.length) {
    const z = text[i]!;
    if (z === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      aus += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 2;
    } else {
      aus += z;
      i++;
    }
  }
  return JSON.parse(aus.replace(/,(\s*[}\]])/g, "$1"));
}

const vorschau = { ...env, UMGEBUNG: "vorschau" as const, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
const admin = (e: object, headers: Record<string, string> = {}) =>
  app.request("http://lokal/api/admin/geraete", { headers }, e as typeof env);

describe("Vorschau: Access-Prüfung aktiv", () => {
  it("ohne ACCESS_* → verweigert (fail closed)", async () => {
    expect((await admin(vorschau)).status).toBeGreaterThanOrEqual(400);
  });

  it("mit ACCESS_*, aber ohne Token → 401", async () => {
    const e = { ...vorschau, ACCESS_TEAM_DOMAIN: "kfz-test.cloudflareaccess.com", ACCESS_AUD: "aud" };
    expect((await admin(e)).status).toBe(401);
  });

  it("mit ACCESS_* und falsch signiertem Token → 401", async () => {
    const e = { ...vorschau, ACCESS_TEAM_DOMAIN: "kfz-test.cloudflareaccess.com", ACCESS_AUD: "aud" };
    const { privateKey } = await generateKeyPair("RS256");
    const t = await new SignJWT({ email: "x@example.de" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer("https://kfz-test.cloudflareaccess.com")
      .setAudience("aud")
      .setExpirationTime("5m")
      .sign(privateKey);
    const echterFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      expect((await admin(e, { "Cf-Access-Jwt-Assertion": t })).status).toBe(401);
    } finally {
      globalThis.fetch = echterFetch;
    }
  });
});

describe("Konfiguration env.vorschau", () => {
  const w = jsonc(wranglerRoh);
  const v = w.env.vorschau;
  const andere = [
    ["produktion", w],
    ["entwicklung", w.env.entwicklung],
  ] as const;

  /** Alle Ressourcennamen einer Ebene (D1, Queues, R2). */
  const ressourcen = (e: any): string[] => [
    ...e.d1_databases.map((d: any) => d.database_name),
    ...e.queues.producers.map((q: any) => q.queue),
    ...e.queues.consumers.flatMap((q: any) => [q.queue, q.dead_letter_queue].filter(Boolean)),
    ...e.r2_buckets.map((b: any) => b.bucket_name),
  ];

  it("setzt UMGEBUNG=vorschau mit leeren ACCESS_*", () => {
    expect(v.vars).toEqual({ UMGEBUNG: "vorschau", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" });
  });

  it("hat D1, Queues samt Dead-Letter, R2, Cron und send_email", () => {
    expect(v.d1_databases[0].database_name).toBe("kfz-bewertung-vorschau");
    expect(v.queues.consumers.some((q: any) => q.dead_letter_queue)).toBe(true);
    expect(v.r2_buckets).toHaveLength(1);
    expect(v.triggers.crons.length).toBeGreaterThan(0);
    expect(v.send_email).toEqual([{ name: "EMAIL" }]);
  });

  it.each(andere)("teilt keine Ressource mit %s", (_name, e) => {
    const eigene = ressourcen(v);
    const fremd = new Set(ressourcen(e));
    expect(eigene.filter((r) => fremd.has(r))).toEqual([]);
  });
});
