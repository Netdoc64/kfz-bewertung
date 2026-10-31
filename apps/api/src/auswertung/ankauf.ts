import type { Fahrzeug } from "@kfz/shared";
import { z } from "zod";
import { AppFehler } from "../fehler/app-fehler.js";
import type { AnfrageUmgebung } from "../anfragen/index.js";

export const AnkaufspreisSchema = z.number().finite().nonnegative().max(10_000_000);

/** Liest den tatsächlichen Preis aus der Aktionseingabe; fehlt er oder ist er unsinnig, bleibt der Status unberührt. */
export function pruefeAnkaufspreis(roh: unknown): number {
  const p = AnkaufspreisSchema.safeParse(roh);
  if (!p.success) throw new AppFehler("ANKAUFSPREIS_UNGUELTIG");
  return Math.round(p.data * 100) / 100;
}

/** Hält Preis und Schätzung fest. Die Schätzung kommt aus dem letzten Bericht der Anfrage (falls vorhanden). */
export async function speichereAnkauf(u: AnfrageUmgebung, anfrageId: string, preisEuro: number, wer: string): Promise<void> {
  const a = await u.db.prepare("SELECT fahrzeug FROM anfragen WHERE id = ?1").bind(anfrageId).first<{ fahrzeug: string }>();
  if (!a) throw new AppFehler("NICHT_GEFUNDEN", undefined, { kontext: { anfrageId } });
  const b = await u.db.prepare("SELECT zahlen FROM berichte WHERE anfrage_id = ?1 ORDER BY generation DESC LIMIT 1").bind(anfrageId).first<{ zahlen: string }>();
  const geschaetzt = b ? (JSON.parse(b.zahlen) as { ankaufspreisEuro?: number | null }).ankaufspreisEuro : undefined;
  const marke = (JSON.parse(a.fahrzeug) as Fahrzeug).marke;
  await u.db
    .prepare(
      `INSERT INTO ankaeufe (anfrage_id, marke, preis_euro, geschaetzt_euro, erfasst_von) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (anfrage_id) DO UPDATE SET preis_euro = excluded.preis_euro, geschaetzt_euro = excluded.geschaetzt_euro, erfasst_von = excluded.erfasst_von`,
    )
    .bind(anfrageId, marke, preisEuro, typeof geschaetzt === "number" ? geschaetzt : null, wer)
    .run();
}

export interface AbweichungsZeile {
  marke: string;
  /** Beschriftung aus den Grenzen, z. B. „bis 5000“, „5000–15000“, „ab 30000“. */
  segment: string;
  anzahl: number;
  /** Mittel von (tatsächlich − geschätzt) in Euro; negativ = tatsächlich günstiger als geschätzt. */
  abweichungEuro: number;
  /** Mittel von (tatsächlich − geschätzt) / geschätzt in Prozent. */
  abweichungProzent: number;
  belastbar: boolean;
}

export function segmentFuer(preis: number, grenzen: readonly number[]): string {
  const g = [...grenzen].sort((a, b) => a - b);
  const i = g.findIndex((x) => preis <= x);
  if (g.length === 0) return "alle";
  if (i === 0) return `bis ${g[0]}`;
  if (i === -1) return `ab ${g[g.length - 1]}`;
  return `${g[i - 1]}–${g[i]}`;
}

const runde = (x: number) => Math.round(x * 100) / 100;

/** Abweichung zwischen Schätzung und tatsächlichem Ankauf je Marke und Segment. Ankäufe ohne Schätzung zählen nicht. */
export async function wertAbweichungAus(u: AnfrageUmgebung): Promise<{ gesamt: number; ohneSchaetzung: number; zeilen: AbweichungsZeile[] }> {
  const [grenzen, mindest] = await Promise.all([u.einstellungen.lese("ankauf.segmentGrenzenEuro"), u.einstellungen.lese("ankauf.auswertungMindestAnzahl")]);
  const { results } = await u.db.prepare("SELECT marke, preis_euro, geschaetzt_euro FROM ankaeufe ORDER BY marke, anfrage_id").all<{ marke: string; preis_euro: number; geschaetzt_euro: number | null }>();
  const gruppen = new Map<string, { marke: string; segment: string; euro: number; prozent: number; n: number }>();
  let ohne = 0;
  for (const r of results) {
    if (r.geschaetzt_euro === null || r.geschaetzt_euro <= 0) {
      ohne++;
      continue;
    }
    const segment = segmentFuer(r.geschaetzt_euro, grenzen);
    const k = `${r.marke}\u0000${segment}`;
    const g = gruppen.get(k) ?? { marke: r.marke, segment, euro: 0, prozent: 0, n: 0 };
    g.euro += r.preis_euro - r.geschaetzt_euro;
    g.prozent += ((r.preis_euro - r.geschaetzt_euro) / r.geschaetzt_euro) * 100;
    g.n++;
    gruppen.set(k, g);
  }
  const zeilen = [...gruppen.values()].map((g) => ({
    marke: g.marke,
    segment: g.segment,
    anzahl: g.n,
    abweichungEuro: runde(g.euro / g.n),
    abweichungProzent: runde(g.prozent / g.n),
    belastbar: g.n >= mindest,
  }));
  return { gesamt: results.length, ohneSchaetzung: ohne, zeilen };
}
