import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Einstellungen } from "../src/einstellungen/dienst.js";
import { verarbeiteBewertungsJob } from "../src/queue/bewertungs-job.js";

const GOLF = JSON.stringify({ marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 70000, leistungKw: 110, ausstattung: [] });
const job = (anfrageId: string) => ({ art: "bewertung", anfrageId, generation: 1, korrelation: "k-1" });
const einst = () => new Einstellungen(env.DB, async () => {});
const mitUmgebung = (u: "entwicklung" | "produktion") => ({ ...env, UMGEBUNG: u });

async function setze(schluessel: string, wert: unknown) {
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES (?1, ?2, 1, 'test')").bind(schluessel, JSON.stringify(wert)).run();
}
async function anfrage(id: string) {
  await env.DB.prepare("INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, geaendert_am) VALUES (?1, 'admin', 'eingegangen', 'A', ?2, ?3, 1, '2020-01-01T00:00:00.000Z')")
    .bind(id, `${id}@example.de`, GOLF)
    .run();
}
const zeile = (id: string) => env.DB.prepare("SELECT status FROM anfragen WHERE id = ?1").bind(id).first<{ status: string }>();
const notizen = async (id: string) =>
  (await env.DB.prepare("SELECT aktion, notiz FROM anfrage_ereignisse WHERE anfrage_id = ?1 ORDER BY id").bind(id).all<{ aktion: string; notiz: string | null }>()).results;
const berichte = async (id: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM berichte WHERE anfrage_id = ?1").bind(id).first<{ n: number }>())!.n;

beforeEach(async () => {
  for (const t of ["anfrage_ereignisse", "berichte", "anfragen", "einstellungen"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await setze("ablauf.eskalation", { konfidenzMin: 0, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true });
});

describe("Produktions-Sperre gegen Beispieldaten", () => {
  it("Produktion + mock: kein Preis, an_mensch mit technischem Grund, kein Bericht", async () => {
    await anfrage("p1");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("p1"), { env: mitUmgebung("produktion") })).toBe("an_mensch");
    expect((await zeile("p1"))!.status).toBe("an_mensch");
    expect((await notizen("p1")).at(-1)).toEqual({ aktion: "uebergeben", notiz: "quelle_mock_produktion" });
    expect(await berichte("p1")).toBe(0);
  });

  it("Entwicklung + mock: zur Freigabe wie bisher", async () => {
    await anfrage("e1");
    expect(await verarbeiteBewertungsJob(env.DB, einst(), job("e1"), { env: mitUmgebung("entwicklung") })).toBe("zur_freigabe");
    expect(await berichte("e1")).toBe(1);
  });

  it("Produktion + live greift die Sperre nicht (Quelle meldet selbst, dass live fehlt)", async () => {
    await setze("quelle.mobilede.modus", "live");
    await anfrage("l1");
    await expect(verarbeiteBewertungsJob(env.DB, einst(), job("l1"), { env: mitUmgebung("produktion") })).rejects.toMatchObject({ code: "QUELLE_ZUGANG" });
    expect(await berichte("l1")).toBe(0);
  });
});
