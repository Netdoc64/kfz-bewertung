import { FahrzeugSchema, uebergang, type Fahrzeug } from "@kfz/shared";
import { z } from "zod";
import type { BewertungsJob } from "../anfragen/index.js";
import { bewerte, ladeBewertungsEinstellungen, type Bewertung } from "../bewertung/bewerten.js";
import { berichtSpeichern } from "../bericht/index.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { waehleQuelle } from "../quelle/index.js";
import type { Suche } from "../quelle/port.js";

export const BewertungsJobSchema = z.object({
  art: z.literal("bewertung"),
  anfrageId: z.string().min(1),
  generation: z.number().int().min(0),
  korrelation: z.string().min(1),
}) satisfies z.ZodType<BewertungsJob>;

/**
 * - `uebersprungen`: nichts zu tun (Not-Aus, anderer Status, schon erledigt)
 * - `zur_freigabe`: Bewertung und Bericht liegen vor, wartet auf den Admin
 * - `an_mensch`: nicht sicher genug oder unbrauchbare Angaben, mit Grund an den Admin übergeben
 * - `fehlgeschlagen`: dauerhafter Fehler, Anfrage steht auf „fehlgeschlagen“
 */
export type JobErgebnis = "uebersprungen" | "zur_freigabe" | "an_mensch" | "fehlgeschlagen";

/** Von außen einsetzbare Teile; ohne Angabe gelten Quelle aus den Einstellungen und die echte Uhr. */
export interface JobAbhaengigkeiten {
  suche?: Suche;
  berichte?: R2Bucket;
  jetzt?: () => Date;
}

interface Zeile {
  status: string;
  version: number;
  generation: number;
  fahrzeug: string;
  sprache: string | null;
}

const LESEN = "SELECT status, version, generation, fahrzeug, sprache FROM anfragen WHERE id = ?1";

/** Statuswechsel samt Ereignis in einem Batch; false, wenn die Anfrage sich zwischenzeitlich geändert hat. */
async function wechsle(
  db: D1Database,
  anfrageId: string,
  von: string,
  version: number,
  aktion: string,
  korrelation: string,
  notiz?: string,
): Promise<boolean> {
  const nach = uebergang(von as never, aktion, "system");
  if (!nach) return false;
  const [upd] = await db.batch([
    db
      .prepare("UPDATE anfragen SET status = ?1, version = version + 1, geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2 AND version = ?3")
      .bind(nach, anfrageId, version),
    db
      .prepare(
        "INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, notiz, korrelation) SELECT ?1, ?2, ?3, ?4, 'system', ?5, ?6 WHERE changes() > 0",
      )
      .bind(anfrageId, aktion, von, nach, notiz ?? null, korrelation),
  ]);
  return upd!.meta.changes > 0;
}

function konflikt(anfrageId: string): AppFehler {
  // Anfrage hat sich zwischen Lesen und Schreiben geändert: Queue stellt neu zu, der zweite Lauf entscheidet frisch.
  return new AppFehler("VERSION_KONFLIKT", undefined, { kontext: { anfrageId } });
}

/**
 * Verarbeitet einen Bewertungsjob (A8). Ältere Generation als die Anfrage → JOB_VERALTET
 * (der neuere Job ist bereits eingereiht). Idempotent: `bewertung_starten` läuft nur aus
 * „eingegangen“ oder „nachbearbeiten“; steht die Anfrage schon in „in_bewertung“ (Lauf
 * unterbrochen), wird die Bewertung zu Ende geführt. Der Bericht entsteht je Generation einmal.
 * Ergebnis: `bewertung_fertig` (nur ohne Übergabegrund), `uebergeben` (mit Grund) oder `fehlschlag`.
 */
export async function verarbeiteBewertungsJob(
  db: D1Database,
  einstellungen: Einstellungen,
  roh: unknown,
  abh: JobAbhaengigkeiten = {},
): Promise<JobErgebnis> {
  const p = BewertungsJobSchema.safeParse(roh);
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", "Ungültiger Bewertungsjob", { details: p.error.issues });
  const job = p.data;

  let z = await db.prepare(LESEN).bind(job.anfrageId).first<Zeile>();
  if (!z) throw new AppFehler("NICHT_GEFUNDEN", undefined, { kontext: { anfrageId: job.anfrageId } });
  if (job.generation < z.generation) {
    throw new AppFehler("JOB_VERALTET", undefined, { kontext: { anfrageId: job.anfrageId, jobGeneration: job.generation, generation: z.generation } });
  }

  // Not-Aus: nichts anlaufen lassen; der Cron reiht die Anfrage nach, sobald der Autopilot wieder an ist.
  if ((await einstellungen.lese("ablauf.autopilot")) === "aus") return "uebersprungen";

  if (z.status !== "in_bewertung") {
    if (!uebergang(z.status as never, "bewertung_starten", "system")) return "uebersprungen";
    if (!(await wechsle(db, job.anfrageId, z.status, z.version, "bewertung_starten", job.korrelation))) throw konflikt(job.anfrageId);
    z = await db.prepare(LESEN).bind(job.anfrageId).first<Zeile>();
    if (!z) throw new AppFehler("NICHT_GEFUNDEN", undefined, { kontext: { anfrageId: job.anfrageId } });
  }
  const anfrage = z;

  const beende = async (aktion: "bewertung_fertig" | "uebergeben" | "fehlschlag", notiz?: string) => {
    const frisch = await db.prepare(LESEN).bind(job.anfrageId).first<Zeile>();
    if (!frisch) throw new AppFehler("NICHT_GEFUNDEN", undefined, { kontext: { anfrageId: job.anfrageId } });
    // Kunde hat währenddessen nachgelegt: der neuere Job bewertet neu, dieses Ergebnis wäre veraltet.
    if (frisch.generation > job.generation) {
      throw new AppFehler("JOB_VERALTET", undefined, { kontext: { anfrageId: job.anfrageId, jobGeneration: job.generation, generation: frisch.generation } });
    }
    if (frisch.status !== "in_bewertung") return;
    if (!(await wechsle(db, job.anfrageId, frisch.status, frisch.version, aktion, job.korrelation, notiz))) throw konflikt(job.anfrageId);
  };

  let fahrzeug: Fahrzeug;
  try {
    fahrzeug = FahrzeugSchema.parse(JSON.parse(anfrage.fahrzeug));
  } catch {
    await beende("uebergeben", "fahrzeug_ungueltig");
    return "an_mensch";
  }

  let bewertung: Bewertung;
  try {
    const suche = abh.suche ?? (await waehleQuelle(einstellungen));
    bewertung = await bewerte({
      fahrzeug,
      suche,
      einstellungen: await ladeBewertungsEinstellungen(einstellungen),
      heute: (abh.jetzt ?? (() => new Date()))(),
    });
  } catch (e) {
    // Wiederholbare Fehler (Quelle gerade nicht erreichbar): Anfrage bleibt in_bewertung, die Queue stellt neu zu.
    if (e instanceof AppFehler && e.definition.wiederholbar) throw e;
    await beende("fehlschlag", e instanceof AppFehler ? e.code : "INTERN");
    throw e;
  }

  const sprache = anfrage.sprache ?? (await einstellungen.lese("antwort.standardSprache"));
  await berichtSpeichern(
    db,
    einstellungen,
    { anfrageId: job.anfrageId, generation: job.generation, fahrzeug, bewertung, sprache, jetzt: (abh.jetzt ?? (() => new Date()))() },
    abh.berichte,
  );

  if (bewertung.anMensch) {
    await beende("uebergeben", bewertung.anMensch.gruende.map((g) => g.code).join(","));
    return "an_mensch";
  }
  await beende("bewertung_fertig");
  return "zur_freigabe";
}
