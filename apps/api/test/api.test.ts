import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FehlerAntwort } from "@kfz/shared";
import { app } from "../src/index.js";
import { schwaerzen } from "../src/fehler/speicher.js";

const BASIS = "http://lokal";

function anfrage(pfad: string, init?: RequestInit) {
  return app.request(`${BASIS}${pfad}`, init, env);
}

function setzen(schluessel: string, wert: unknown, version: number) {
  return anfrage(`/api/admin/einstellungen/${schluessel}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wert, version }),
  });
}

describe("Gesundheit und Fehlerformat", () => {
  it("meldet ok und vergibt eine Korrelations-ID", async () => {
    const r = await anfrage("/api/gesundheit");
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Korrelations-Id")).toBeTruthy();
  });

  it("übernimmt eine gültige eingehende Korrelations-ID", async () => {
    const r = await anfrage("/api/gesundheit", { headers: { "X-Korrelations-Id": "abc-12345678" } });
    expect(r.headers.get("X-Korrelations-Id")).toBe("abc-12345678");
  });

  it("antwortet bei unbekanntem Pfad im einheitlichen Fehlerformat", async () => {
    const r = await anfrage("/api/gibtsnicht");
    expect(r.status).toBe(404);
    const b = (await r.json()) as FehlerAntwort;
    expect(b.fehler.code).toBe("NICHT_GEFUNDEN");
    expect(b.fehler.korrelationsId).toBe(r.headers.get("X-Korrelations-Id"));
  });
});

describe("Einstellungen", () => {
  it("liefert alle Schlüssel mit Standardwerten und einen Abdruck", async () => {
    const r = await anfrage("/api/admin/einstellungen");
    const b = (await r.json()) as { abdruck: string; eintraege: { schluessel: string; quelle: string; version: number }[] };
    expect(b.abdruck).toMatch(/^[0-9a-f]{12}$/);
    const marge = b.eintraege.find((e) => e.schluessel === "ankauf.margeProzent");
    expect(marge).toMatchObject({ quelle: "standard", version: 0 });
  });

  it("setzt, versioniert, prüft auf Konflikt und setzt zurück", async () => {
    const r1 = await setzen("ankauf.margeProzent", 15, 0);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ wert: 15, version: 1, quelle: "gespeichert" });

    const konflikt = await setzen("ankauf.margeProzent", 20, 0);
    expect(konflikt.status).toBe(409);
    expect(((await konflikt.json()) as FehlerAntwort).fehler.code).toBe("VERSION_KONFLIKT");

    const zurueck = await setzen("ankauf.margeProzent", null, 1);
    expect(await zurueck.json()).toMatchObject({ wert: 12, version: 2, quelle: "standard" });

    const v = await anfrage("/api/admin/einstellungen/ankauf.margeProzent/verlauf");
    const { verlauf } = (await v.json()) as { verlauf: { version: number; wertNachher: unknown }[] };
    expect(verlauf.map((x) => x.version)).toEqual([2, 1]);
    expect(verlauf[0]!.wertNachher).toBeNull();
  });

  it("lehnt Werte ab, die nicht zum Schema passen", async () => {
    const r = await setzen("ankauf.margeProzent", 150, 0);
    expect(r.status).toBe(400);
    const b = (await r.json()) as FehlerAntwort;
    expect(b.fehler.code).toBe("EINGABE_UNGUELTIG");
    expect(b.fehler.details).toBeDefined();
  });

  it("lässt die Freigabepflicht nicht abschalten", async () => {
    const r = await setzen("ablauf.freigabePflicht", false, 0);
    expect(r.status).toBe(400);
  });

  it("kennt keine erfundenen Schlüssel", async () => {
    const r = await setzen("gibt.es.nicht", 1, 0);
    expect(r.status).toBe(404);
    expect(((await r.json()) as FehlerAntwort).fehler.code).toBe("EINSTELLUNG_UNBEKANNT");
  });

  it("fällt bei kaputtem gespeichertem Wert auf den Standard zurück und meldet es", async () => {
    await env.DB.prepare("INSERT INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')")
      .bind("bewertung.mindestVergleiche", JSON.stringify("acht"))
      .run();

    const r = await anfrage("/api/admin/einstellungen/bewertung.mindestVergleiche");
    expect(await r.json()).toMatchObject({ wert: 8, quelle: "standard_ersatz" });

    const f = await anfrage("/api/admin/fehler");
    const { fehler } = (await f.json()) as { fehler: { code: string; id: number }[] };
    const eintrag = fehler.find((x) => x.code === "EINSTELLUNG_UNGUELTIG");
    expect(eintrag).toBeDefined();

    const q = await anfrage(`/api/admin/fehler/${eintrag!.id}/quittieren`, { method: "POST" });
    expect(q.status).toBe(200);
    const nochmal = await anfrage(`/api/admin/fehler/${eintrag!.id}/quittieren`, { method: "POST" });
    expect(nochmal.status).toBe(404);
  });
});

describe("Admin-Zugang in Produktion", () => {
  it("verweigert ohne Access-Konfiguration", async () => {
    const r = await app.request(`${BASIS}/api/admin/einstellungen`, undefined, { ...env, UMGEBUNG: "produktion" });
    expect(r.status).toBe(500);
  });

  it("verweigert ohne Access-Token", async () => {
    const r = await app.request(`${BASIS}/api/admin/einstellungen`, undefined, {
      ...env,
      UMGEBUNG: "produktion",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    });
    expect(r.status).toBe(401);
    expect(((await r.json()) as FehlerAntwort).fehler.code).toBe("NICHT_ANGEMELDET");
  });

  it("lässt die Gesundheitsprüfung offen", async () => {
    const r = await app.request(`${BASIS}/api/gesundheit`, undefined, { ...env, UMGEBUNG: "produktion" });
    expect(r.status).toBe(200);
  });
});

describe("Fehlerspeicher", () => {
  it("zählt gleiche Fehler unter einem Fingerabdruck", async () => {
    for (const s of ["a", "b", "c"]) {
      await env.DB.prepare("INSERT INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test') ON CONFLICT DO UPDATE SET wert = excluded.wert")
        .bind("bewertung.zielVergleiche", JSON.stringify(s))
        .run();
      await anfrage("/api/admin/einstellungen/bewertung.zielVergleiche");
    }
    const r = await env.DB.prepare("SELECT anzahl FROM fehler_ereignisse WHERE code = 'EINSTELLUNG_UNGUELTIG' AND nachricht LIKE '%zielVergleiche%'").first<{ anzahl: number }>();
    expect(r?.anzahl).toBe(3);
  });

  it("schwärzt Geheimnisse und Personendaten im Kontext", () => {
    expect(schwaerzen({ apiKey: "x", kunde: { telefon: "0171", name: "A" }, fin: "W", liste: [{ token: "t" }] })).toEqual({
      apiKey: "[geschwärzt]",
      kunde: { telefon: "[geschwärzt]", name: "A" },
      fin: "[geschwärzt]",
      liste: [{ token: "[geschwärzt]" }],
    });
  });
});
