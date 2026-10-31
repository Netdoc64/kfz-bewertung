import { KraftstoffSchema, type Fahrzeug, type SuchStufe } from "@kfz/shared";
import { z } from "zod";

/** Ein Vergleichsinserat der Datenquelle. Fehlende Angaben bleiben fehlend, nie geraten. */
export const VergleichsinseratSchema = z.object({
  id: z.string().min(1),
  titel: z.string(),
  beschreibung: z.string().optional(),
  preisBruttoEuro: z.number().nonnegative(),
  preisNettoEuro: z.number().nonnegative().optional(),
  kilometer: z.number().int().nonnegative().optional(),
  /** Format JJJJ-MM */
  erstzulassung: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  leistungKw: z.number().positive().optional(),
  kraftstoff: KraftstoffSchema.optional(),
  anbieter: z.enum(["haendler", "privat"]),
});

export type Vergleichsinserat = z.infer<typeof VergleichsinseratSchema>;

/** Schnittstelle zur Datenquelle (Mock oder mobile.de). Fehler als AppFehler mit QUELLE_*-Code. */
export interface Suche {
  suche(fahrzeug: Fahrzeug, stufe: SuchStufe): Promise<Vergleichsinserat[]>;
}
