import { describe, expect, it } from "vitest";
import { EINSTELLUNGEN } from "@kfz/shared";
import { rendere } from "../src/ansicht.js";
import { erzeugeApi, type Abruf } from "../src/api.js";
import { Steuerung } from "../src/steuerung.js";

const antwort = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = EINSTELLUNGEN["oberflaeche.beschriftungen"].standard["hinweis.quelle_mock_produktion"]!;

function server(notiz: string | null) {
  const abruf: Abruf = async (url) => {
    if (url.endsWith("/oberflaeche.beschriftungen")) return antwort({ wert: { "hinweis.quelle_mock_produktion": text } });
    if (url.endsWith("/ablauf.statusBeschriftungen")) return antwort({ wert: {} });
    if (url.endsWith("/a1")) {
      return antwort({
        anfrage: { id: "a1", status: "an_mensch", statusText: "An Mensch", version: 3, kunde_name: "Max", kunde_kontakt: "m@example.org", fahrzeug: "{}" },
        ereignisse: [{ id: 1, aktion: "uebergeben", status_von: "in_bewertung", status_nach: "an_mensch", statusNachText: "An Mensch", durch: "system", notiz, am: "2026-01-01T10:00:00Z" }],
        aktionen: [],
        nachrichten: [],
        kundenNachrichten: [],
        bericht: null,
      });
    }
    return antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg" } }, 404);
  };
  return abruf;
}

async function detail(notiz: string | null) {
  const st = new Steuerung(erzeugeApi(server(notiz)));
  await st.start();
  await st.oeffne("a1");
  return rendere(st.zustand);
}

describe("Hinweis „keine Live-Daten“", () => {
  it("steht in der Registry-Beschriftung", () => {
    expect(text).toMatch(/Keine Live-Daten/);
  });
  it("erscheint im Detail, wenn der Grund quelle_mock_produktion am Ereignis steht", async () => {
    const html = await detail("quelle_mock_produktion");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Keine Live-Daten");
  });
  it("erscheint nicht bei anderen Gründen", async () => {
    expect(await detail("fahrzeug_ungueltig")).not.toContain("Keine Live-Daten");
    expect(await detail(null)).not.toContain("Keine Live-Daten");
  });
});
