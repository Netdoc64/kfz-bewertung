import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";

/**
 * Lasttest Phase 8: 500 Anfragen über die Mock-Quelle, Queue-Batches mit doppelt zugestellten
 * Nachrichten und parallel laufenden Batches. Jede Anfrage muss genau einmal bewertet werden.
 *
 * Laufzeitrahmen: Die Bewertung rechnet gegen die eingebaute Mock-Quelle und lokales D1, ohne Netz.
 * 500 Anfragen (plus rund 500 Wiederzustellungen) brauchen auf einem Entwicklerrechner wenige Sekunden;
 * 120 s ist ein grober Rahmen mit Luft für den langsamen CI-Runner. Er fängt eine Regression von
 * linear zu quadratisch (etwa ein Tabellenscan je Nachricht) oder eine hängende Wiederholungsschleife,
 * nicht Millisekunden-Schwankungen.
 */
const RAHMEN_MS = 120_000;
const ANZAHL = 500;
const BATCH_GROESSE = 10;
const PARALLEL = 5;
const MAX_RUNDEN = 6;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const gesendet: unknown[] = [];
const testEnv = () => ({
  ...env,
  BEWERTUNG_QUEUE: { send: async (j: unknown) => void gesendet.push(j), sendBatch: async (l: { body: unknown }[]) => void gesendet.push(...l.map((x) => x.body)) } as unknown as Queue<unknown>,
});

type Nachricht = { body: unknown; versuche: number };
const job = (id: string) => ({ art: "bewertung", anfrageId: id, generation: 1, korrelation: `k-${id}` });
const id = (i: number) => `last-${String(i).padStart(3, "0")}`;

function batchVon(nachrichten: Nachricht[], ergebnis: { acks: number; wieder: Nachricht[] }) {
  return {
    queue: "bewertung",
    messages: nachrichten.map((n) => ({
      body: n.body,
      ack: () => void ergebnis.acks++,
      retry: () => void ergebnis.wieder.push({ body: n.body, versuche: n.versuche + 1 }),
    })),
    ackAll() {},
    retryAll() {},
  } as unknown as MessageBatch<unknown>;
}

async function zaehle(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())!.n;
}

beforeAll(async () => {
  for (const t of ["nachrichten", "anfrage_ereignisse", "berichte", "freigabe_benachrichtigungen", "anfragen", "einstellungen", "fehler_ereignisse"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  // Die Beispieldaten reichen für die Standard-Konfidenz nicht; die Schwelle ist eine Einstellung, kein Code.
  await env.DB.prepare("INSERT OR REPLACE INTO einstellungen (schluessel, wert, version, geaendert_von) VALUES ('ablauf.eskalation', ?1, 1, 'test')")
    .bind(JSON.stringify({ konfidenzMin: 0, maxAnkaufEuro: 1000000, ausgeschlosseneKlassen: [], sonstigesAnMensch: true }))
    .run();
  const stmts = [];
  for (let i = 0; i < ANZAHL; i++) {
    const fahrzeug = JSON.stringify({ marke: "VW", modell: "Golf", kraftstoff: "diesel", erstzulassung: "2020-06", kilometer: 40000 + i * 100, leistungKw: 110, ausstattung: [] });
    stmts.push(
      env.DB.prepare("INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, fahrzeug, generation, geaendert_am) VALUES (?1, 'admin', 'eingegangen', 'A', ?2, ?3, 1, '2020-01-01T00:00:00.000Z')").bind(id(i), `${id(i)}@example.de`, fahrzeug),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
});

describe("Lasttest Bewertungs-Job", () => {
  it(`bewertet ${ANZAHL} Anfragen genau einmal, auch bei Wiederzustellung und parallelen Batches`, async () => {
    // Jede Nachricht zweimal: einmal im Hauptstrom, einmal als Wiederzustellung in einem späteren Batch.
    let offen: Nachricht[] = [];
    for (let i = 0; i < ANZAHL; i++) offen.push({ body: job(id(i)), versuche: 0 });
    for (let i = 0; i < ANZAHL; i++) offen.push({ body: job(id(i)), versuche: 0 });
    // Die Dubletten liegen weit hinten und teils im selben Parallelblock wie das Original.
    offen = [...offen.slice(0, ANZAHL), ...offen.slice(ANZAHL).reverse()];

    const ergebnis = { acks: 0, wieder: [] as Nachricht[] };
    const start = performance.now();
    let runde = 0;
    while (offen.length && runde++ < MAX_RUNDEN) {
      const batches = [];
      for (let i = 0; i < offen.length; i += BATCH_GROESSE) batches.push(batchVon(offen.slice(i, i + BATCH_GROESSE), ergebnis));
      ergebnis.wieder = [];
      for (let i = 0; i < batches.length; i += PARALLEL) {
        await Promise.all(batches.slice(i, i + PARALLEL).map((b) => worker.queue!(b, testEnv(), ctx)));
      }
      offen = ergebnis.wieder;
    }
    const dauerMs = performance.now() - start;

    expect(offen, "Nachrichten, die nach allen Runden noch wiederholt werden").toEqual([]);
    expect(dauerMs, `Laufzeit ${Math.round(dauerMs)} ms`).toBeLessThan(RAHMEN_MS);

    // Jede Anfrage steht am Ende zur Freigabe oder bei einem Menschen, nie mehr in Bewertung.
    expect(await zaehle("SELECT COUNT(*) AS n FROM anfragen WHERE status IN ('zur_freigabe', 'nachbearbeiten', 'an_mensch')")).toBe(ANZAHL);

    // Genau ein Bericht je Anfrage.
    expect(await zaehle("SELECT COUNT(*) AS n FROM berichte")).toBe(ANZAHL);
    expect(await zaehle("SELECT COUNT(DISTINCT anfrage_id) AS n FROM berichte")).toBe(ANZAHL);

    // Jeder Statuswechsel genau einmal je Anfrage.
    const doppelt = await env.DB.prepare("SELECT anfrage_id, aktion, COUNT(*) AS n FROM anfrage_ereignisse GROUP BY anfrage_id, aktion HAVING n > 1").all();
    expect(doppelt.results).toEqual([]);
    expect(await zaehle("SELECT COUNT(*) AS n FROM anfrage_ereignisse WHERE aktion = 'bewertung_starten'")).toBe(ANZAHL);
    expect(await zaehle("SELECT COUNT(*) AS n FROM anfrage_ereignisse WHERE aktion IN ('bewertung_fertig', 'uebergeben')")).toBe(ANZAHL);

    // Höchstens eine Freigabe-Meldung je Anfrage und Generation (Primärschlüssel), nie mehr als eine Mail.
    expect(await zaehle("SELECT COUNT(*) AS n FROM freigabe_benachrichtigungen")).toBeLessThanOrEqual(ANZAHL);

    // Kein Preis ohne Freigabe: der Job versendet nichts an Kunden.
    expect(await zaehle("SELECT COUNT(*) AS n FROM nachrichten")).toBe(0);
    expect(await zaehle("SELECT COUNT(*) AS n FROM anfragen WHERE status IN ('freigegeben', 'gesendet', 'abgeschlossen')")).toBe(0);
  }, RAHMEN_MS + 60_000);
});
