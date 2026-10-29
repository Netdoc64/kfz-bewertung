import type { Schwere } from "@kfz/shared";
import type { BewertungsJob } from "../anfragen/index.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";

const ORT_GEPARKT = "cron:eingang_geparkt";

/**
 * Reiht Anfragen im Status „eingegangen“ ein, die bei Autopilot „aus“ nicht eingereiht wurden
 * (oder deren Job verloren ging). Idempotent: der Job selbst startet die Bewertung nur einmal;
 * die Mindestwartezeit verhindert, dass ein noch nicht verarbeiteter Job doppelt eingereiht wird.
 */
export async function holeNach(db: D1Database, einstellungen: Einstellungen, queue: Queue<unknown>, korrelation: string, jetzt = Date.now()): Promise<number> {
  if ((await einstellungen.lese("ablauf.autopilot")) === "aus") return 0;
  const minuten = await einstellungen.lese("ablauf.nachholenNachMinuten");
  const max = await einstellungen.lese("ablauf.nachholenMaxJeLauf");
  const grenze = new Date(jetzt - minuten * 60_000).toISOString();
  const { results } = await db
    .prepare("SELECT id, generation FROM anfragen WHERE status = 'eingegangen' AND geaendert_am <= ?1 ORDER BY erstellt_am LIMIT ?2")
    .bind(grenze, max)
    .all<{ id: string; generation: number }>();
  if (results.length === 0) return 0;
  const jobs: BewertungsJob[] = results.map((r) => ({ art: "bewertung", anfrageId: r.id, generation: r.generation, korrelation }));
  await queue.sendBatch(jobs.map((body) => ({ body })));
  // geaendert_am vorrücken: bis zur nächsten Frist gilt die Anfrage als eingereiht.
  await db.batch(
    results.map((r) => db.prepare("UPDATE anfragen SET geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1 AND generation = ?2").bind(r.id, r.generation)),
  );
  return results.length;
}

/**
 * Zeigt Eingänge, die der Flutschutz geparkt hat, dem Admin: ein Eintrag im Fehlerspeicher
 * (und damit Alarm A4), sobald seit der letzten Meldung neue dazugekommen sind.
 */
export async function meldeGeparkte(db: D1Database, korrelation: string, abSchwere: Schwere, email?: SendEmail): Promise<number> {
  const neu = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM eingang_geparkt
       WHERE erstellt_am > COALESCE((SELECT zuletzt FROM fehler_ereignisse WHERE ort = ?1 ORDER BY zuletzt DESC LIMIT 1), '')`,
    )
    .bind(ORT_GEPARKT)
    .first<{ n: number }>();
  const n = neu?.n ?? 0;
  if (n === 0) return 0;
  const fehler = new AppFehler("ZU_VIELE_ANFRAGEN", "Geparkte Eingänge warten auf Prüfung (Flutschutz)", { kontext: { neu: n } });
  await fehlerSpeichern(db, { fehler, ort: ORT_GEPARKT, korrelationsId: korrelation }, abSchwere, email);
  return n;
}
