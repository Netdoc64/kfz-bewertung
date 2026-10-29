import { describe, expect, it } from "vitest";
import { rendere } from "../src/ansicht.js";
import { erzeugeApi, type Abruf, type EinstellungsEintrag, type FehlerEintrag } from "../src/api.js";
import { Steuerung } from "../src/steuerung.js";

const eintrag = (schluessel: string, wert: unknown, version = 2): EinstellungsEintrag => ({
  schluessel,
  wert,
  standard: 1,
  version,
  quelle: "gespeichert",
  gruppe: "ablauf",
  beschreibung: "Eine <Beschreibung>",
  geaendertAm: null,
  geaendertVon: null,
});

const fehler = (id: number): FehlerEintrag => ({
  id,
  code: "QUELLE_NICHT_ERREICHBAR",
  schwere: "fehler",
  ort: "cron",
  nachricht: "<script>x</script>",
  letzteKorrelation: "k-9",
  anzahl: 3,
  erstmals: "2026-01-01T10:00:00Z",
  zuletzt: "2026-01-02T10:00:00Z",
  quittiertAm: null,
});

interface Aufruf {
  url: string;
  init?: RequestInit | undefined;
}

const antwort = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(opt: { put?: () => Response; quittieren?: () => Response } = {}) {
  const aufrufe: Aufruf[] = [];
  const abruf: Abruf = async (url, init) => {
    aufrufe.push({ url, init });
    if (url.includes("/einstellungen/oberflaeche.beschriftungen")) return antwort({ wert: { konflikt: "Neu geladen." } });
    if (url.includes("/einstellungen/ablauf.statusBeschriftungen")) return antwort({ wert: {} });
    if (url.endsWith("/einstellungen")) return antwort({ abdruck: "x", eintraege: [eintrag("eingang.maxJeAbsenderUndTag", 5), eintrag("ablauf.autopilot", "an", 0)] });
    if (url.includes("/einstellungen/") && init?.method === "PUT") return opt.put ? opt.put() : antwort(eintrag("eingang.maxJeAbsenderUndTag", 6, 3));
    if (url.includes("/fehler?")) return antwort({ fehler: [fehler(7)] });
    if (url.endsWith("/quittieren")) return opt.quittieren ? opt.quittieren() : antwort({ ok: true });
    return antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg" } }, 404);
  };
  return { aufrufe, abruf };
}

const puts = (a: Aufruf[]) => a.filter((x) => x.init?.method === "PUT");

describe("Einstellungen bearbeiten", () => {
  it("lädt die Liste und sendet den Wert mit der gesehenen Version", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeEinstellungen();
    st.bearbeite("eingang.maxJeAbsenderUndTag");
    st.tippe("6");
    await st.speichere();
    const put = puts(s.aufrufe)[0];
    expect(put?.url).toBe("/api/admin/einstellungen/eingang.maxJeAbsenderUndTag");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ wert: 6, version: 2 });
    expect(st.zustand.bearbeitung).toBeNull();
    expect(st.zustand.ansicht).toBe("einstellungen");
  });

  it("sendet bei ungültigem JSON nichts", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeEinstellungen();
    st.bearbeite("ablauf.autopilot");
    st.tippe("{kaputt");
    await st.speichere();
    expect(puts(s.aufrufe)).toHaveLength(0);
    expect(st.zustand.meldung).toMatchObject({ art: "fehler", code: "EINGABE_UNGUELTIG" });
  });

  it("zeigt Plausibilitätswarnungen und speichert erst beim zweiten, bewussten Speichern", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeEinstellungen();
    st.bearbeite("eingang.maxJeAbsenderUndTag");
    st.tippe("100000");
    await st.speichere();
    expect(puts(s.aufrufe)).toHaveLength(0);
    expect(st.zustand.bearbeitung?.warnungen.length).toBeGreaterThan(0);
    expect(rendere(st.zustand)).toContain("data-speichern");
    await st.speichere();
    expect(puts(s.aufrufe)).toHaveLength(1);
  });

  it("setzt mit null auf den Standard zurück", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeEinstellungen();
    st.bearbeite("eingang.maxJeAbsenderUndTag");
    await st.speichere(true);
    expect(JSON.parse(String(puts(s.aufrufe)[0]?.init?.body))).toEqual({ wert: null, version: 2 });
  });

  it("lädt bei VERSION_KONFLIKT neu und sendet nicht erneut", async () => {
    const s = server({ put: () => antwort({ fehler: { code: "VERSION_KONFLIKT", text: "alt" } }, 409) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.zeigeEinstellungen();
    st.bearbeite("eingang.maxJeAbsenderUndTag");
    st.tippe("6");
    await st.speichere();
    expect(puts(s.aufrufe)).toHaveLength(1);
    expect(st.zustand.meldung).toMatchObject({ art: "konflikt", text: "Neu geladen." });
    expect(st.zustand.bearbeitung).toBeNull();
  });

  it("zeigt Schemafehler des Servers mit Code", async () => {
    const s = server({ put: () => antwort({ fehler: { code: "EINSTELLUNG_UNGUELTIG", text: "passt nicht", korrelationsId: "k-2" } }, 422) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeEinstellungen();
    st.bearbeite("ablauf.autopilot");
    await st.speichere();
    expect(st.zustand.meldung).toMatchObject({ code: "EINSTELLUNG_UNGUELTIG", korrelationsId: "k-2" });
    expect(st.zustand.bearbeitung).not.toBeNull();
  });

  it("maskiert Beschreibung und Wert in der Ansicht", async () => {
    const st = new Steuerung(erzeugeApi(server().abruf));
    await st.zeigeEinstellungen();
    st.bearbeite("ablauf.autopilot");
    const html = rendere(st.zustand);
    expect(html).toContain("Eine &lt;Beschreibung&gt;");
    expect(html).toContain("<textarea data-wert");
  });
});

describe("Fehlerliste", () => {
  it("lädt offene Fehler, maskiert Texte und quittiert", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeFehler();
    const html = rendere(st.zustand);
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain('data-quittiere="7"');
    await st.quittiere(7);
    expect(s.aufrufe.some((a) => a.url === "/api/admin/fehler/7/quittieren" && a.init?.method === "POST")).toBe(true);
    expect(s.aufrufe.at(-1)?.url).toBe("/api/admin/fehler?offen=ja");
  });

  it("lädt neu, wenn der Fehler schon quittiert war", async () => {
    const s = server({ quittieren: () => antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg" } }, 404) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeFehler();
    await st.quittiere(7);
    expect(st.zustand.meldung).toBeNull();
    expect(st.zustand.fehlerListe).toHaveLength(1);
  });
});
