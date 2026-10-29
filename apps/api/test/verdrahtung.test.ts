import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { app } from "../src/index.js";
import { VergleichsinseratSchema } from "../src/quelle/port.js";

const anfrage = (pfad: string) => app.request(`http://lokal${pfad}`, undefined, env);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("Verdrahtung", () => {
  it("Gesundheit antwortet", async () => {
    expect((await anfrage("/api/gesundheit")).status).toBe(200);
  });

  it("leere Router sind eingehängt (404 aus dem Router, nicht 401/500) — Admin hinter Access", async () => {
    for (const pfad of ["/api/anfragen/x", "/api/admin/anfragen/x", "/api/admin/dead-letter/x", "/api/admin/kennzahlen/x"]) {
      expect((await anfrage(pfad)).status, pfad).toBe(404);
    }
  });

  it("Admin-Bereich verlangt in Produktion ein Access-Token", async () => {
    const r = await app.request("http://lokal/api/admin/anfragen/x", undefined, {
      ...env,
      UMGEBUNG: "produktion",
      ACCESS_TEAM_DOMAIN: "t.example.com",
      ACCESS_AUD: "aud",
    });
    expect(r.status).toBe(401);
  });

  it("Handler-Stubs werfen nicht", async () => {
    let bestaetigt = false;
    const batch = { queue: "bewertung", messages: [], ackAll: () => (bestaetigt = true), retryAll() {} } as unknown as MessageBatch<unknown>;
    await expect(worker.queue!(batch, env, ctx)).resolves.toBeUndefined();
    expect(bestaetigt).toBe(true);
    await expect(worker.scheduled!({ cron: "*/15 * * * *", scheduledTime: 0, type: "scheduled", noRetry() {} } as ScheduledController, env, ctx)).resolves.toBeUndefined();
    await expect(worker.email!({ headers: new Headers(), from: "kunde@example.com" } as ForwardableEmailMessage, env, ctx)).resolves.toBeUndefined();
  });

  it("Vergleichsinserat-Schema nimmt ein gültiges Inserat an", () => {
    expect(VergleichsinseratSchema.safeParse({ id: "1", titel: "t", preisBruttoEuro: 1000, anbieter: "privat" }).success).toBe(true);
    expect(VergleichsinseratSchema.safeParse({ id: "1", titel: "t", preisBruttoEuro: -1, anbieter: "privat" }).success).toBe(false);
  });
});
