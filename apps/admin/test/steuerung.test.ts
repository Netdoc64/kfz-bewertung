import { describe, expect, it } from "vitest";
import { rendere } from "../src/ansicht.js";
import { erzeugeApi, type Abruf, type Detail } from "../src/api.js";
import { Steuerung } from "../src/steuerung.js";

const anfrage = (version: number, status = "zur_freigabe") => ({
  id: "a1",
  kanal: "formular",
  status,
  statusText: "Wartet auf Freigabe",
  version,
  kunde_name: "<b>Max</b>",
  kunde_kontakt: "max@example.org",
  fahrzeug: { marke: "VW", modell: "Golf" },
  erstellt_am: "2026-01-01T10:00:00Z",
  geaendert_am: "2026-01-02T10:00:00Z",
});

const detail = (version: number): Detail =>
  ({
    anfrage: anfrage(version),
    ereignisse: [{ id: 1, aktion: "bewertung_fertig", status_von: "in_bewertung", status_nach: "zur_freigabe", statusNachText: "Wartet auf Freigabe", durch: "system", notiz: null, am: "2026-01-02T10:00:00Z" }],
    nachrichten: [{ id: "n1", kanal: "email", anlass: "eingang", inhalt: "Hallo", status: "gesendet", erstellt_am: "2026-01-01T10:01:00Z" }],
    kundenNachrichten: [],
    bericht: { generation: 1, gueltigBis: "2026-02-01T00:00:00Z", html: "<p>Bericht</p>" },
    aktionen: [{ name: "freigeben", nach: "freigegeben", nachText: "Freigegeben" }],
  }) as Detail;

interface Aufruf {
  url: string;
  init?: RequestInit | undefined;
}

function antwort(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake-API; `aktion` darf eine Antwort liefern, `version` ist der aktuelle Stand auf dem Server. */
function server(opt: { version: number; aktion?: () => Response }) {
  const aufrufe: Aufruf[] = [];
  const abruf: Abruf = async (url, init) => {
    aufrufe.push({ url, init });
    if (url.endsWith("/oberflaeche.beschriftungen")) return antwort({ wert: { konflikt: "Neu geladen.", "aktion.freigeben": "Freigeben", titel: "Anfragen" } });
    if (url.endsWith("/ablauf.statusBeschriftungen")) return antwort({ wert: { zur_freigabe: "Wartet auf Freigabe" } });
    if (url.includes("/anfragen?")) return antwort({ eintraege: [anfrage(opt.version)], seite: 1, proSeite: 25, gesamt: 1 });
    if (url.endsWith("/aktion")) return opt.aktion ? opt.aktion() : antwort({ version: opt.version + 1 });
    if (url.endsWith("/anfragen/a1")) return antwort(detail(opt.version));
    return antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg" } }, 404);
  };
  return { aufrufe, abruf };
}

describe("Admin-Steuerung", () => {
  it("lädt Liste mit Statusfilter und Seite", async () => {
    const s = server({ version: 3 });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    expect(st.zustand.liste?.gesamt).toBe(1);
    await st.setzeFilter("zur_freigabe");
    await st.geheZuSeite(1);
    const urls = s.aufrufe.map((a) => a.url).filter((u) => u.includes("/anfragen?"));
    expect(urls.at(-1)).toBe("/api/admin/anfragen?seite=1&status=zur_freigabe");
  });

  it("sendet die gesehene Version mit und lädt danach neu", async () => {
    const s = server({ version: 3 });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.oeffne("a1");
    await st.fuehreAus("freigeben", "ok");
    const post = s.aufrufe.find((a) => a.url.endsWith("/aktion"));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ aktion: "freigeben", version: 3, notiz: "ok" });
    expect(st.zustand.meldung).toBeNull();
    expect(s.aufrufe.at(-1)?.url).toBe("/api/admin/anfragen/a1");
  });

  it("lädt bei VERSION_KONFLIKT neu und sendet nicht erneut", async () => {
    const s = server({ version: 4, aktion: () => antwort({ fehler: { code: "VERSION_KONFLIKT", text: "alt" } }, 409) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.oeffne("a1");
    // Server hat sich zwischenzeitlich verändert.
    st.zustand.detail = detail(3);
    await st.fuehreAus("freigeben");
    expect(s.aufrufe.filter((a) => a.url.endsWith("/aktion"))).toHaveLength(1);
    expect(st.zustand.meldung).toMatchObject({ art: "konflikt", text: "Neu geladen." });
    expect(st.zustand.detail?.anfrage.version).toBe(4);
  });

  it("zeigt andere Fehler mit Code und Korrelations-ID", async () => {
    const s = server({ version: 3, aktion: () => antwort({ fehler: { code: "AUTOPILOT_GESPERRT", text: "gesperrt", korrelationsId: "k-1" } }, 409) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.oeffne("a1");
    await st.fuehreAus("freigeben");
    expect(st.zustand.meldung).toMatchObject({ art: "fehler", code: "AUTOPILOT_GESPERRT", korrelationsId: "k-1" });
    expect(rendere(st.zustand)).toContain("k-1");
  });
});

describe("Admin-Ansicht", () => {
  it("maskiert Kundendaten und zeigt Aktionen aus dem Feld aktionen", async () => {
    const st = new Steuerung(erzeugeApi(server({ version: 3 }).abruf));
    await st.start();
    expect(rendere(st.zustand)).toContain("&lt;b&gt;Max&lt;/b&gt;");
    await st.oeffne("a1");
    const html = rendere(st.zustand);
    expect(html).toContain('data-aktion="freigeben"');
    expect(html).toContain(">Freigeben<");
    expect(html).toContain("<iframe sandbox");
    expect(html).not.toContain("<b>Max</b>");
  });
});
