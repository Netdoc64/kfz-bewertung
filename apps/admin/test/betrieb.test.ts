import { describe, expect, it } from "vitest";
import { rendere } from "../src/ansicht.js";
import { erzeugeApi, type Abruf } from "../src/api.js";
import { Steuerung } from "../src/steuerung.js";

interface Aufruf {
  url: string;
  init?: RequestInit | undefined;
}

const antwort = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const eintrag = (id: number, extra: object = {}) => ({
  id,
  nachricht_id: `m${id}`,
  queue: "bewertung",
  anfrage_id: "a1",
  job_generation: 1,
  korrelation: "k-1",
  nutzlast: {},
  versuche: 4,
  erstellt_am: "2026-01-01T10:00:00Z",
  erneut_am: null,
  erneut_von: null,
  erneut_generation: null,
  ...extra,
});

const dauer = { anzahl: 2, mittel: 7200, median: 7200, max: 9000 };
const kennzahlen = {
  zeitraum: { von: "2026-01-01T00:00:00.000Z", bis: "2026-01-31T00:00:00.000Z" },
  anfragen: 5,
  durchlaufzeit: { zur_freigabe: dauer, offen: 1 },
  anMensch: { anzahl: 2, anteil: 0.4, mitGrund: 2, anteilMitGrund: 1, gruende: { "<b>konfidenz</b>": 2 } },
  konfidenz: { berichte: 4, mittel: 0.8, klassen: [{ von: null, bis: 0.5, anzahl: 1 }, { von: 0.5, bis: null, anzahl: 3 }] },
  fehlerrate: { bewertungen: 5, fehlgeschlagen: 1, rate: 0.2 },
  freigabedauer: dauer,
  ki: {
    aufrufe: 3,
    anfragen: 2,
    tokenEin: 1500,
    tokenAus: 300,
    kostenEuro: 0.0123,
    kostenJeAnfrage: 0.00615,
    faehigkeiten: { "auslesen<x>": { aufrufe: 2, tokenEin: 1000, tokenAus: 200, kostenEuro: 0.008 }, formulieren: { aufrufe: 1, tokenEin: 500, tokenAus: 100, kostenEuro: 0.0043 } },
  },
};
const abweichungen = {
  gesamt: 3,
  ohneSchaetzung: 1,
  zeilen: [{ marke: "VW", segment: "5000–15000", anzahl: 2, abweichungEuro: -250, abweichungProzent: -3.5, belastbar: false }],
};

function server(opt: { erneut?: () => Response } = {}) {
  const aufrufe: Aufruf[] = [];
  const abruf: Abruf = async (url, init) => {
    aufrufe.push({ url, init });
    if (url.includes("/oberflaeche.beschriftungen")) return antwort({ wert: { bereitsEingereiht: "Schon eingereiht.", navKennzahlen: "Kennzahlen", kennzahlKi: "KI-Nutzung", kennzahlKiTokenEin: "Token ein", kennzahlKiTokenAus: "Token aus", kennzahlKiKosten: "Kosten", kennzahlKiKostenJeAnfrage: "Kosten je Anfrage", kennzahlKiAufrufe: "Aufrufe", kennzahlKiFaehigkeit: "Fähigkeit", kennzahlKiLeer: "Keine KI-Nutzung.", einheitStunden: "Std.", erneutEinreihen: "Erneut einreihen" } });
    if (url.includes("/ablauf.statusBeschriftungen")) return antwort({ wert: { zur_freigabe: "Wartet auf Freigabe" } });
    if (url.endsWith("/dead-letter")) return antwort({ eintraege: [eintrag(7)] });
    if (url.endsWith("/dead-letter/7/erneut")) return opt.erneut ? opt.erneut() : antwort({ ...eintrag(7, { erneut_am: "x" }), bereitsEingereiht: false });
    if (url.includes("/kennzahlen")) return antwort(kennzahlen);
    if (url.endsWith("/auswertung/ankaeufe")) return antwort(abweichungen);
    if (url.endsWith("/aktion")) return antwort({ version: 4 });
    if (url.endsWith("/anfragen/a1"))
      return antwort({
        anfrage: { id: "a1", kanal: "formular", status: "besichtigung", statusText: "Besichtigung", version: 3, kunde_name: "Max", kunde_kontakt: null, fahrzeug: {}, erstellt_am: "2026-01-01T10:00:00Z", geaendert_am: "2026-01-01T10:00:00Z" },
        ereignisse: [],
        nachrichten: [],
        kundenNachrichten: [],
        bericht: null,
        aktionen: [{ name: "ankauf_abschliessen", nach: "ankauf", nachText: "Ankauf abschließen" }],
      });
    return antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg" } }, 404);
  };
  return { aufrufe, abruf };
}

const body = (a: Aufruf) => JSON.parse(String(a.init?.body));

describe("Dead-Letter-Ansicht", () => {
  it("listet offene Einträge und zeigt den Knopf", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.zeigeDeadLetter();
    const html = rendere(st.zustand);
    expect(html).toContain('data-erneut="7"');
    expect(html).toContain("k-1");
  });

  it("reiht erneut ein und lädt die Liste neu", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.zeigeDeadLetter();
    await st.reiheErneutEin(7);
    const posts = s.aufrufe.filter((a) => a.init?.method === "POST");
    expect(posts.map((a) => a.url)).toEqual(["/api/admin/dead-letter/7/erneut"]);
    expect(s.aufrufe.filter((a) => a.url.endsWith("/dead-letter")).length).toBe(2);
    expect(st.zustand.meldung).toBeNull();
  });

  it("meldet bereitsEingereiht als Hinweis statt als Fehler", async () => {
    const s = server({ erneut: () => antwort({ ...eintrag(7, { erneut_am: "x" }), bereitsEingereiht: true }) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.reiheErneutEin(7);
    expect(st.zustand.meldung).toMatchObject({ art: "konflikt", text: "Schon eingereiht." });
  });

  it("zeigt einen API-Fehler mit Code", async () => {
    const s = server({ erneut: () => antwort({ fehler: { code: "NICHT_GEFUNDEN", text: "weg", korrelationsId: "k9" } }, 404) });
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.reiheErneutEin(7);
    expect(st.zustand.meldung).toMatchObject({ art: "fehler", code: "NICHT_GEFUNDEN", korrelationsId: "k9" });
  });
});

describe("Kennzahlen-Seite", () => {
  it("lädt ohne Zeitraum den Standard der API und zeigt Kennzahlen samt Abweichung", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.zeigeKennzahlen();
    expect(s.aufrufe.some((a) => a.url === "/api/admin/kennzahlen")).toBe(true);
    const html = rendere(st.zustand);
    expect(html).toContain("Wartet auf Freigabe");
    expect(html).toContain("2 Std.");
    expect(html).toMatch(/40\s%/);
    expect(html).toContain("&lt;b&gt;konfidenz&lt;/b&gt;");
    expect(html).toContain("5000–15000");
    expect(html).toContain("-250");
  });

  it("zeigt KI-Token und -Kosten, auch je Fähigkeit und je Anfrage (maskiert)", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.start();
    await st.zeigeKennzahlen();
    const html = rendere(st.zustand);
    expect(html).toContain("KI-Nutzung");
    expect(html).toContain("1.500");
    expect(html).toContain("Kosten: 0,0123 €");
    expect(html).toContain("Kosten je Anfrage: 0,0062 €");
    expect(html).toContain("auslesen&lt;x&gt;");
    expect(html).not.toContain("auslesen<x>");
  });

  it("sendet den gewählten Zeitraum als ISO-Grenzen", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.setzeZeitraum("2026-01-01", "2026-01-31");
    const url = s.aufrufe.find((a) => a.url.includes("/kennzahlen"))!.url;
    const q = new URL(url, "http://x").searchParams;
    expect(q.get("von")).toBe("2026-01-01T00:00:00Z");
    expect(q.get("bis")).toBe("2026-01-31T23:59:59Z");
    expect(rendere(st.zustand)).toContain('value="2026-01-01"');
  });
});

describe("Ankaufspreis bei ankauf_abschliessen (A11)", () => {
  it("zeigt das Preisfeld und sendet den Preis (Komma erlaubt)", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.oeffne("a1");
    expect(rendere(st.zustand)).toContain("data-preis");
    await st.fuehreAus("ankauf_abschliessen", undefined, "12500,50");
    const post = s.aufrufe.find((a) => a.url.endsWith("/aktion"))!;
    expect(body(post)).toEqual({ aktion: "ankauf_abschliessen", version: 3, ankaufspreisEuro: 12500.5 });
  });

  it("sendet ohne Eingabe keinen Preis; die API entscheidet", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.oeffne("a1");
    await st.fuehreAus("ankauf_abschliessen", undefined, "abc");
    expect(body(s.aufrufe.find((a) => a.url.endsWith("/aktion"))!)).not.toHaveProperty("ankaufspreisEuro");
  });

  it("sendet bei anderen Aktionen keinen Preis", async () => {
    const s = server();
    const st = new Steuerung(erzeugeApi(s.abruf));
    await st.oeffne("a1");
    await st.fuehreAus("absagen", undefined, "100");
    expect(body(s.aufrufe.find((a) => a.url.endsWith("/aktion"))!)).not.toHaveProperty("ankaufspreisEuro");
  });
});
