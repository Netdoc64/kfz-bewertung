import { KraftstoffSchema, type Fahrzeug, type SuchStufe } from "@kfz/shared";
import { z } from "zod";
import { AppFehler } from "../fehler/app-fehler.js";
import { ALLE_SEGMENTE } from "./beispieldaten/index.js";
import type { MockSegment } from "./beispieldaten/typen.js";
import { VergleichsinseratSchema, type Suche, type Vergleichsinserat } from "./port.js";

/** Rohantwort der Mock-Quelle; Brutto und Netto liegen nebeneinander, wie bei Händlerinseraten. */
const RohInseratSchema = z.object({
  id: z.string().min(1),
  titel: z.string(),
  beschreibung: z.string().optional(),
  marke: z.string().min(1),
  modell: z.string().min(1),
  preisBrutto: z.number().nonnegative(),
  preisNetto: z.number().nonnegative().optional(),
  preisAnzeige: z.enum(["brutto", "netto"]),
  km: z.number().int().nonnegative().optional(),
  ez: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  kw: z.number().positive().optional(),
  kraftstoff: KraftstoffSchema.optional(),
  anbieter: z.enum(["haendler", "privat"]),
});

type RohInserat = z.infer<typeof RohInseratSchema>;

function monate(ez: string): number {
  const [j, m] = ez.split("-").map(Number) as [number, number];
  return j * 12 + (m - 1);
}

function gleich(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Fehlt dem Inserat eine Angabe, nach der gefiltert wird, scheidet es aus — es wird nichts geraten. */
function passt(f: Fahrzeug, s: SuchStufe, r: RohInserat): boolean {
  if (!gleich(f.marke, r.marke) || !gleich(f.modell, r.modell)) return false;
  if (f.kraftstoff && r.kraftstoff !== f.kraftstoff) return false;
  if (f.erstzulassung) {
    if (!r.ez) return false;
    if (Math.abs(monate(r.ez) - monate(f.erstzulassung)) > s.ezToleranzJahre * 12) return false;
  }
  if (f.kilometer !== undefined) {
    if (r.km === undefined) return false;
    if (Math.abs(r.km - f.kilometer) > (f.kilometer * s.kmToleranzProzent) / 100) return false;
  }
  if (f.leistungKw !== undefined) {
    if (r.kw === undefined) return false;
    if (Math.abs(r.kw - f.leistungKw) > (f.leistungKw * s.leistungToleranzProzent) / 100) return false;
  }
  // Der Umkreis bleibt unberücksichtigt: Beispieldaten haben keinen Standort.
  return true;
}

function uebersetzen(r: RohInserat): Vergleichsinserat {
  return VergleichsinseratSchema.parse({
    id: r.id,
    titel: r.titel,
    beschreibung: r.beschreibung,
    preisBruttoEuro: r.preisBrutto,
    preisNettoEuro: r.preisNetto,
    kilometer: r.km,
    erstzulassung: r.ez,
    leistungKw: r.kw,
    kraftstoff: r.kraftstoff,
    anbieter: r.anbieter,
  });
}

/** Mock-mobile.de: liefert feste Beispieldaten, gefiltert nach den Toleranzen der Suchstufe. */
export class MockSuche implements Suche {
  constructor(private readonly segmente: MockSegment[] = ALLE_SEGMENTE) {}

  async suche(fahrzeug: Fahrzeug, stufe: SuchStufe): Promise<Vergleichsinserat[]> {
    const treffer: Vergleichsinserat[] = [];
    for (const segment of this.segmente) {
      for (const roh of segment.inserate) {
        const geprueft = RohInseratSchema.safeParse(roh);
        if (!geprueft.success) {
          throw new AppFehler("QUELLE_ANTWORT_UNGUELTIG", undefined, {
            kontext: { segment: segment.schluessel, probleme: geprueft.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
          });
        }
        if (passt(fahrzeug, stufe, geprueft.data)) treffer.push(uebersetzen(geprueft.data));
      }
    }
    return treffer;
  }
}
