import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index.js";

// Offizielle Turnstile-Testschlüssel (Cloudflare-Doku): immer bestanden / immer durchgefallen.
const GEHEIMNIS_OK = "1x0000000000000000000000000000000AA";
const GEHEIMNIS_FALSCH = "2x0000000000000000000000000000000AA";
const SITE_KEY = "1x00000000000000000000AA";

const anfrage = (pfad: string, init?: RequestInit, e: object = env) => app.request(`http://lokal${pfad}`, init, e);
const code = async (r: Response) => ((await r.json()) as { fehler: { code: string } }).fehler.code;
const body = (extra: object = {}) => ({ name: "Erika", kontakt: "erika@example.de", fahrzeug: { marke: "VW", modell: "Golf" }, ...extra });
const post = (daten: object, e: object = env) =>
  anfrage("/api/anfragen", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "9.9.9.9" }, body: JSON.stringify(daten) }, e);

const anzahl = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM anfragen").first<{ n: number }>())!.n;

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}

/** Gemockte siteverify-Antwort nach Cloudflares Testverhalten: das Geheimnis entscheidet. */
function mockeSiteverify() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const f = init?.body as URLSearchParams;
    const ok = f.get("secret") === GEHEIMNIS_OK && f.get("response") === "token-gut";
    return new Response(JSON.stringify({ success: ok }), { status: 200 });
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM ratenzaehler").run();
  await env.DB.prepare("DELETE FROM einstellungen WHERE schluessel LIKE 'formular.%'").run();
});
afterEach(() => vi.restoreAllMocks());

describe("GET /formular", () => {
  it("zeigt Registry-Texte, Felder und den Datenschutzhinweis", async () => {
    const r = await anfrage("/formular");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const h = await r.text();
    expect(h).toContain("Ihr Fahrzeug – unverbindlich bewerten lassen");
    expect(h).toContain('name="fahrzeug.marke"');
    expect(h).toContain('name="fahrzeug.kraftstoff"');
    expect(h).toMatch(/id="datenschutz">[^<]*Wir verarbeiten Ihre Angaben/);
  });

  it("ein geänderter Registry-Wert erscheint auf der Seite", async () => {
    await setze("formular.texte", { titel: "Auto verkaufen", senden: "Los" });
    await setze("formular.datenschutzhinweis", "Eigener Hinweis A14");
    await setze("formular.felder", [{ name: "name", label: "Wie heißen Sie?", typ: "text", pflicht: true }]);
    const h = await (await anfrage("/formular")).text();
    expect(h).toContain("Auto verkaufen");
    expect(h).toContain("Eigener Hinweis A14");
    expect(h).toContain("Wie heißen Sie?");
    expect(h).not.toContain("fahrzeug.marke");
  });

  it("maskiert HTML aus der Registry", async () => {
    await setze("formular.texte", { titel: "<script>alert(1)</script>" });
    await setze("formular.datenschutzhinweis", `"><img src=x onerror=alert(1)>`);
    const h = await (await anfrage("/formular")).text();
    expect(h).not.toContain("<script>alert");
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("CSP erlaubt nur Eigenes und Turnstile; Widget nur mit Site-Key", async () => {
    const ohne = await anfrage("/formular");
    const csp = ohne.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(await ohne.text()).not.toContain("cf-turnstile");

    await setze("formular.turnstileSiteKey", SITE_KEY);
    const mit = await (await anfrage("/formular")).text();
    expect(mit).toContain(`data-sitekey="${SITE_KEY}"`);
    expect(mit).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
  });

  it("liefert Skript und Stil ohne Anmeldung", async () => {
    expect((await anfrage("/formular/formular.js")).headers.get("content-type")).toContain("javascript");
    expect((await anfrage("/formular/formular.css")).headers.get("content-type")).toContain("css");
  });

  it("wird vom Worker-Einstieg bedient, nicht vom Admin-Web", async () => {
    const { default: worker } = await import("../src/index.js");
    const r = await worker.fetch!(new Request("http://lokal/formular"), { ...env, UMGEBUNG: "produktion", ACCESS_TEAM_DOMAIN: "t.example", ACCESS_AUD: "aud" } as never, {} as never);
    expect(r.status).toBe(200);
  });
});

describe("POST /api/anfragen mit Turnstile", () => {
  it("Entwicklung ohne Geheimnis lässt durch (kein fetch)", async () => {
    const f = mockeSiteverify();
    expect((await post(body())).status).toBe(201);
    expect(f).not.toHaveBeenCalled();
  });

  it.each(["produktion", "vorschau"] as const)("%s ohne Geheimnis weist ab (fail closed)", async (u) => {
    const r = await post(body({ turnstileToken: "token-gut" }), { ...env, UMGEBUNG: u });
    expect(r.status).toBe(503);
    expect(await code(r)).toBe("BOT_SCHUTZ_NICHT_KONFIGURIERT");
  });

  it("Token fehlt → abgewiesen, keine Anfrage", async () => {
    mockeSiteverify();
    const vorher = await anzahl();
    const r = await post(body(), { ...env, TURNSTILE_GEHEIMNIS: GEHEIMNIS_OK });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("BOT_SCHUTZ_ABGELEHNT");
    expect(await anzahl()).toBe(vorher);
  });

  it("ungültiges Token → abgewiesen", async () => {
    mockeSiteverify();
    const r = await post(body({ turnstileToken: "token-schlecht" }), { ...env, TURNSTILE_GEHEIMNIS: GEHEIMNIS_OK });
    expect(r.status).toBe(403);
    const r2 = await post(body({ turnstileToken: "token-gut" }), { ...env, TURNSTILE_GEHEIMNIS: GEHEIMNIS_FALSCH });
    expect(r2.status).toBe(403);
  });

  it("nicht erreichbare Prüfung → abgewiesen", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("netz"));
    const r = await post(body({ turnstileToken: "token-gut" }), { ...env, TURNSTILE_GEHEIMNIS: GEHEIMNIS_OK });
    expect(r.status).toBe(403);
  });

  it("gültiges Token → Anfrage angelegt, Prüfung mit Geheimnis und IP", async () => {
    const f = mockeSiteverify();
    const vorher = await anzahl();
    const r = await post(body({ turnstileToken: "token-gut" }), { ...env, UMGEBUNG: "produktion", TURNSTILE_GEHEIMNIS: GEHEIMNIS_OK });
    expect(r.status).toBe(201);
    expect(await anzahl()).toBe(vorher + 1);
    const gesendet = f.mock.calls[0]![1]!.body as URLSearchParams;
    expect(gesendet.get("remoteip")).toBe("9.9.9.9");
    expect(String(f.mock.calls[0]![0])).toContain("challenges.cloudflare.com/turnstile/v0/siteverify");
  });
});
