import { describe, expect, it } from "vitest";
import { rendere, rendereKopplung } from "../src/ansicht.js";
import { erzeugeAppApi, istAppModus, koppeln, ladeKopplung, type Speicher } from "../src/app-modus.js";
import { Steuerung } from "../src/steuerung.js";

const antwort = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function speicher(): Speicher & { daten: Map<string, string> } {
  const daten = new Map<string, string>();
  return { daten, getItem: (k) => daten.get(k) ?? null, setItem: (k, v) => void daten.set(k, v), removeItem: (k) => void daten.delete(k) };
}

const anfrage = {
  id: "a1", kanal: "app", status: "zur_freigabe", statusText: "Wartet auf Freigabe", version: 2, kunde_name: "Max", kunde_kontakt: null,
  fahrzeug: { marke: "VW", modell: "Golf" }, erstellt_am: "2026-01-01T10:00:00Z", geaendert_am: "2026-01-02T10:00:00Z",
};

describe("App-Modus", () => {
  it("erkennt Capacitor", () => {
    expect(istAppModus({ Capacitor: {} })).toBe(true);
    expect(istAppModus({})).toBe(false);
  });

  it("Kopplung speichert Adresse und Token und ruft <adresse>/api/app/koppeln", async () => {
    const sp = speicher();
    const urls: { url: string; body: unknown }[] = [];
    const k = await koppeln(
      async (url, init) => {
        urls.push({ url, body: JSON.parse(String(init?.body)) });
        return antwort({ geraetId: "g1", token: "tok", ablaufAm: "2027-01-01T00:00:00Z" }, 201);
      },
      { adresse: " https://api.example.test/ ", code: " ABC ", name: "Handy" },
      sp,
    );
    expect(urls).toEqual([{ url: "https://api.example.test/api/app/koppeln", body: { code: "ABC", name: "Handy" } }]);
    expect(k).toEqual({ adresse: "https://api.example.test", token: "tok" });
    expect(ladeKopplung(sp)).toEqual(k);
  });

  it("lehnt ungültige Adresse ab und meldet Fehler der API", async () => {
    const sp = speicher();
    await expect(koppeln(async () => antwort({}), { adresse: "keine adresse", code: "x", name: "n" }, sp)).rejects.toMatchObject({ code: "EINGABE_UNGUELTIG" });
    await expect(
      koppeln(async () => antwort({ fehler: { code: "KOPPLUNGSCODE_UNGUELTIG", text: "falsch" } }, 400), { adresse: "https://a.test", code: "x", name: "n" }, sp),
    ).rejects.toMatchObject({ code: "KOPPLUNGSCODE_UNGUELTIG", status: 400 });
    expect(ladeKopplung(sp)).toBeNull();
  });

  it("Aufrufe gehen an <adresse>/api/app mit Authorization", async () => {
    const aufrufe: { url: string; init?: RequestInit | undefined }[] = [];
    const api = erzeugeAppApi(
      async (url, init) => {
        aufrufe.push({ url, init });
        if (url.includes("/aktion")) return antwort({ version: 3 });
        return antwort({ eintraege: [anfrage], seite: 1, proSeite: 25, gesamt: 1 });
      },
      { adresse: "https://api.example.test", token: "tok" },
    );
    const st = new Steuerung(api, () => {}, { appModus: true });
    await st.ladeListe();
    await api.aktion("a1", "freigeben", 2);
    expect(aufrufe.map((a) => a.url)).toEqual(["https://api.example.test/api/app?seite=1", "https://api.example.test/api/app/a1/aktion"]);
    for (const a of aufrufe) expect((a.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect((aufrufe[1]?.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("401 und GERAET_WIDERRUFEN führen zurück zur Kopplung", async () => {
    for (const [status, code] of [[401, "NICHT_ANGEMELDET"], [403, "GERAET_WIDERRUFEN"]] as const) {
      let widerrufen = 0;
      const api = erzeugeAppApi(async () => antwort({ fehler: { code, text: "x" } }, status), { adresse: "https://a.test", token: "t" });
      const st = new Steuerung(api, () => {}, { appModus: true, beiWiderruf: () => void widerrufen++ });
      await st.start();
      expect(widerrufen).toBe(1);
    }
  });

  it("start lädt Beschriftungen und Statusnamen mit einem Abruf von /api/app/beschriftungen", async () => {
    const urls: string[] = [];
    const api = erzeugeAppApi(
      async (url) => {
        urls.push(url);
        if (url.endsWith("/beschriftungen")) return antwort({ beschriftungen: { titel: "T" }, statusBeschriftungen: { zur_freigabe: "Wartet" } });
        return antwort({ eintraege: [], seite: 1, proSeite: 25, gesamt: 0 });
      },
      { adresse: "https://a.test", token: "t" },
    );
    const st = new Steuerung(api, () => {}, { appModus: true });
    await st.start();
    expect(urls.filter((u) => u.endsWith("/beschriftungen"))).toEqual(["https://a.test/api/app/beschriftungen"]);
    expect(st.zustand.beschriftungen["titel"]).toBe("T");
    expect(st.zustand.statusNamen["zur_freigabe"]).toBe("Wartet");
  });

  it("zeigt bei leerem Fehlertext den appFehler.<code>-Text", async () => {
    const api = erzeugeAppApi(
      async (url) => {
        if (url.endsWith("/beschriftungen")) return antwort({ beschriftungen: { "appFehler.NETZ": "Keine Verbindung." }, statusBeschriftungen: {} });
        throw new Error("offline");
      },
      { adresse: "https://a.test", token: "t" },
    );
    const st = new Steuerung(api, () => {}, { appModus: true });
    await st.start();
    expect(st.zustand.meldung?.text).toBe("Keine Verbindung.");
  });

  it("im Admin-Web löst 401 keine Kopplung aus", async () => {
    let widerrufen = 0;
    const api = erzeugeAppApi(async () => antwort({ fehler: { code: "NICHT_ANGEMELDET", text: "x" } }, 401), { adresse: "https://a.test", token: "t" });
    const st = new Steuerung(api, () => {}, { beiWiderruf: () => void widerrufen++ });
    await st.ladeListe();
    expect(widerrufen).toBe(0);
    expect(st.zustand.meldung?.code).toBe("NICHT_ANGEMELDET");
  });

  it("zeigt im App-Modus nur Anfragen in der Navigation und rendert die Kopplungsansicht", async () => {
    const api = erzeugeAppApi(async () => antwort({ eintraege: [anfrage], seite: 1, proSeite: 25, gesamt: 1 }), { adresse: "https://a.test", token: "t" });
    const st = new Steuerung(api, () => {}, { appModus: true });
    await st.ladeListe();
    const html = rendere(st.zustand);
    expect(html).toContain('data-nav="anfragen"');
    for (const n of ["einstellungen", "fehler", "deadletter", "kennzahlen"]) expect(html).not.toContain(`data-nav="${n}"`);
    const form = rendereKopplung((k) => k, { code: "KOPPLUNGSCODE_UNGUELTIG", text: "<b>" }, false, "https://a.test");
    expect(form).toContain("data-koppeln");
    expect(form).toContain("&lt;b&gt;");
  });
});
