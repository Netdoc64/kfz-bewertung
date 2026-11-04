import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rauchtest } from "../src/rauchtest.mjs";

const gesundAntwort = {
  ok: true,
  umgebung: "produktion",
  d1: "ok",
  queue: "bereit",
  einstellungen: { abdruck: "abc123def456", gespeicherteSchluessel: 3 },
  autopilot: true,
  quelleModus: "live",
};

function attrappe(gesund: unknown, gesundStatus = 200, einfach: unknown = { ok: true }, einfachStatus = 200) {
  return (async (url: string | URL | Request) => {
    const pfad = new URL(String(url)).pathname;
    const [body, status] = pfad === "/api/gesund" ? [gesund, gesundStatus] : [einfach, einfachStatus];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("rauchtest", () => {
  it("meldet gesunden Deploy als bestanden", async () => {
    const r = await rauchtest("https://x.example/", { fetch: attrappe(gesundAntwort) });
    expect(r.ok).toBe(true);
    expect(r.befunde.every((b) => b.stufe === "ok")).toBe(true);
  });

  it("scheitert bei D1 aus (503)", async () => {
    const r = await rauchtest("https://x.example", {
      fetch: attrappe({ fehler: { code: "DATENBANK" } }, 503, { ok: false }, 500),
    });
    expect(r.ok).toBe(false);
    expect(r.befunde.map((b) => b.text).join("|")).toContain("DATENBANK");
  });

  it("scheitert bei D1/Queue/Abdruck/Autopilot/Quelle nicht ok", async () => {
    const r = await rauchtest("https://x.example", {
      fetch: attrappe({ ok: false, umgebung: "entwicklung", d1: "aus", queue: "fehlt", einstellungen: {}, autopilot: null, quelleModus: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.befunde.filter((b) => b.stufe === "fehler").length).toBeGreaterThanOrEqual(6);
  });

  it("scheitert bei falscher Antwortform", async () => {
    const html = (async () => new Response("<html>nein</html>", { status: 200 })) as typeof fetch;
    const r = await rauchtest("https://x.example", { fetch: html });
    expect(r.ok).toBe(false);
    expect(r.befunde[0]?.text).toContain("kein JSON");
    expect((await rauchtest("https://x.example", { fetch: attrappe([1]) })).ok).toBe(false);
  });

  it("scheitert in Produktion mit Quelle-Modus mock, nicht aber in Entwicklung", async () => {
    const prod = await rauchtest("https://x.example", { fetch: attrappe({ ...gesundAntwort, quelleModus: "mock" }) });
    expect(prod.ok).toBe(false);
    expect(prod.befunde.some((b) => b.text.includes("mock"))).toBe(true);
    const dev = await rauchtest("https://x.example", {
      fetch: attrappe({ ...gesundAntwort, umgebung: "entwicklung", quelleModus: "mock" }),
    });
    expect(dev.ok).toBe(true);
  });

  it("scheitert bei Zeitüberschreitung", async () => {
    const haengt = ((_u: unknown, init?: RequestInit) =>
      new Promise((_a, ab) => init?.signal?.addEventListener("abort", () => ab(new Error("abgebrochen"))))) as typeof fetch;
    const r = await rauchtest("https://x.example", { fetch: haengt, zeitlimitMs: 20 });
    expect(r.ok).toBe(false);
    expect(r.befunde.some((b) => b.text.includes("Zeitüberschreitung"))).toBe(true);
  });

  it("scheitert bei Netzfehler", async () => {
    const r = await rauchtest("https://x.example", {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.befunde.some((b) => b.text.includes("nicht erreichbar"))).toBe(true);
  });

  it("scheitert bei fehlender oder ungültiger URL", async () => {
    expect((await rauchtest(undefined)).ok).toBe(false);
    expect((await rauchtest("kein-link")).befunde[0]?.text).toContain("URL");
  });

  describe("gegen lokalen Server", () => {
    let server: Server;
    let url: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url === "/api/gesund" ? { ...gesundAntwort, umgebung: "entwicklung" } : { ok: true }));
      });
      await new Promise<void>((fertig) => server.listen(0, "127.0.0.1", fertig));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((fertig) => server.close(() => fertig())));

    it("besteht über echtes HTTP", async () => {
      expect((await rauchtest(url)).ok).toBe(true);
    });
  });
});
