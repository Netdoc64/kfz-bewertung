import { describe, expect, it } from "vitest";
import { EINSTELLUNGEN } from "@kfz/shared";
import { rendere } from "../src/ansicht.js";
import { erzeugeApi, type Abruf, type GeparkterEintrag } from "../src/api.js";
import { Steuerung } from "../src/steuerung.js";

const antwort = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const eintrag = (id: string, grund: string, kanal = "email"): GeparkterEintrag => ({
  id,
  kontakt: "max@example.org",
  kanal,
  nutzlast: { name: "Max", betreff: "<b>Mein Golf</b>", text: "Verkauf" },
  grund,
  erstellt_am: "2026-01-01T10:00:00Z",
  geprueft_am: null,
  geprueft_von: null,
  entscheidung: null,
  anfrage_id: null,
});

function server(opt: { freigabe?: () => Response } = {}) {
  const aufrufe: { url: string; init?: RequestInit | undefined }[] = [];
  const abruf: Abruf = async (url, init) => {
    aufrufe.push({ url, init });
    if (url.endsWith("/oberflaeche.beschriftungen")) return antwort({ wert: { "geparktGrund.ki_sonstiges": "KI: Sonstiges", "geparktGrund.mail_unklar": "Unklar" } });
    if (url.endsWith("/ablauf.statusBeschriftungen")) return antwort({ wert: {} });
    if (url.endsWith("/geparkt")) return antwort({ eintraege: [eintrag("g1", "ki_sonstiges"), eintrag("g2", "flutschutz", "formular")] });
    if (url.endsWith("/freigeben")) return opt.freigabe ? opt.freigabe() : antwort({ id: "a1" }, 201);
    if (url.endsWith("/verwerfen") || url.endsWith("/pruefen")) return antwort(eintrag("g1", "ki_sonstiges"));
    return antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg" } }, 404);
  };
  return { aufrufe, abruf };
}

describe("Ansicht geparkter Eingänge", () => {
  it("zeigt benannte Gründe aus den Beschriftungen und maskiert Mailtext", async () => {
    const st = new Steuerung(erzeugeApi(server().abruf));
    await st.start();
    await st.zeigeGeparkt();
    const html = rendere(st.zustand);
    expect(html).toContain("KI: Sonstiges");
    expect(html).not.toContain("<b>Mein Golf</b>");
    expect(html).toContain("&lt;b&gt;Mein Golf");
    // Mail verlangt Fahrzeugfelder, das Formular-Eingang nicht.
    expect(html.match(/data-geparkt-feld="marke"/g)?.length).toBe(1);
  });

  it("sendet Fahrzeugangaben bei der Freigabe und lädt die Liste neu", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeGeparkt();
    await st.gibGeparktFrei("g1", " VW ", "Golf", "", "");
    const post = s.aufrufe.find((a) => a.url.endsWith("/g1/freigeben"));
    expect(JSON.parse(String(post?.init?.body))).toEqual({ fahrzeug: { marke: "VW", modell: "Golf" } });
    expect(s.aufrufe.filter((a) => a.url.endsWith("/geparkt")).length).toBe(2);
  });

  it("verwirft und markiert als geprüft", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.verwirfGeparkt("g1");
    await st.pruefeGeparkt("g1");
    expect(s.aufrufe.filter((a) => a.init?.method === "POST").map((a) => a.url)).toEqual(["/api/admin/geparkt/g1/verwerfen", "/api/admin/geparkt/g1/pruefen"]);
  });

  it("zeigt bei schon entschiedenem Eingang den Konflikt und lädt neu", async () => {
    const st = new Steuerung(erzeugeApi(server({ freigabe: () => antwort({ fehler: { code: "STATUSWECHSEL_UNZULAESSIG", text: "Schon entschieden" } }, 409) }).abruf));
    await st.zeigeGeparkt();
    await st.gibGeparktFrei("g1", "VW", "Golf");
    expect(st.zustand.meldung).toMatchObject({ art: "konflikt", code: "STATUSWECHSEL_UNZULAESSIG" });
    expect(st.zustand.geparkt?.length).toBe(2);
  });

  it("hat für jeden Grund einen Nutzertext in der Registry", () => {
    const b = EINSTELLUNGEN["oberflaeche.beschriftungen"].standard as Record<string, string>;
    for (const g of ["flutschutz", "mail_unklar", "ki_sonstiges", "ki_rueckfrage_unzuordenbar"]) expect(b[`geparktGrund.${g}`]).toBeTruthy();
  });
});
