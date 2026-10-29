import { uebergang } from "@kfz/shared";
import { z } from "zod";
import type { BewertungsJob } from "../anfragen/index.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";

export const BewertungsJobSchema = z.object({
  art: z.literal("bewertung"),
  anfrageId: z.string().min(1),
  generation: z.number().int().min(0),
  korrelation: z.string().min(1),
}) satisfies z.ZodType<BewertungsJob>;

export type JobErgebnis = "gestartet" | "uebersprungen";

interface Zeile {
  status: string;
  version: number;
  generation: number;
}

/**
 * Verarbeitet einen Bewertungsjob (A8). Ältere Generation als die Anfrage → JOB_VERALTET
 * (der neuere Job ist bereits eingereiht). Idempotent: nur aus „eingegangen“ oder
 * „nachbearbeiten“ wird `bewertung_starten` ausgeführt, jede weitere Zustellung ist ein No-op.
 */
export async function verarbeiteBewertungsJob(db: D1Database, einstellungen: Einstellungen, roh: unknown): Promise<JobErgebnis> {
  const p = BewertungsJobSchema.safeParse(roh);
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Ungültiger Bewertungsjob", { details: p.error.issues });
  const job = p.data;

  const z = await db.prepare("SELECT status, version, generation FROM anfragen WHERE id = ?1").bind(job.anfrageId).first<Zeile>();
  if (!z) throw new AppFehler("NICHT_GEFUNDEN", undefined, { kontext: { anfrageId: job.anfrageId } });
  if (job.generation < z.generation) {
    throw new AppFehler("JOB_VERALTET", undefined, { kontext: { anfrageId: job.anfrageId, jobGeneration: job.generation, generation: z.generation } });
  }

  // Not-Aus: nichts anlaufen lassen; der Cron reiht die Anfrage nach, sobald der Autopilot wieder an ist.
  if ((await einstellungen.lese("ablauf.autopilot")) === "aus") return "uebersprungen";

  const nach = uebergang(z.status as never, "bewertung_starten", "system");
  if (!nach) return "uebersprungen";

  const [upd] = await db.batch([
    db
      .prepare("UPDATE anfragen SET status = ?1, version = version + 1, geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2 AND version = ?3")
      .bind(nach, job.anfrageId, z.version),
    db
      .prepare(
        "INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, korrelation) SELECT ?1, 'bewertung_starten', ?2, ?3, 'system', ?4 WHERE changes() > 0",
      )
      .bind(job.anfrageId, z.status, nach, job.korrelation),
  ]);
  // Anfrage hat sich zwischen Lesen und Schreiben geändert: Queue stellt neu zu, der zweite Lauf entscheidet frisch.
  if (upd!.meta.changes === 0) throw new AppFehler("VERSION_KONFLIKT", undefined, { kontext: { anfrageId: job.anfrageId } });
  return "gestartet";
}
