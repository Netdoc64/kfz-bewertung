import { z } from "zod";

/**
 * Fahrzeugmerkmale, wie sie aus einer Anfrage kommen. Alles außer Marke/Modell
 * ist optional: fehlende Angaben werden nachgefragt, nie geraten.
 */
export const KraftstoffSchema = z.enum(["benzin", "diesel", "elektro", "hybrid", "plugin_hybrid", "lpg", "cng", "wasserstoff", "sonstige"]);
export const GetriebeSchema = z.enum(["manuell", "automatik", "halbautomatik"]);
export const ZustandSchema = z.enum(["unfallfrei", "repariert", "beschaedigt", "nicht_fahrbereit"]);

export const FahrzeugSchema = z.object({
  marke: z.string().trim().min(1),
  modell: z.string().trim().min(1),
  variante: z.string().trim().optional(),
  fin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, "FIN hat 17 Zeichen ohne I, O, Q")
    .optional(),
  hsn: z.string().regex(/^\d{4}$/).optional(),
  tsn: z.string().regex(/^[A-Z0-9]{3}$/i).optional(),
  erstzulassung: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Format JJJJ-MM")
    .optional(),
  kilometer: z.number().int().nonnegative().optional(),
  leistungKw: z.number().positive().optional(),
  kraftstoff: KraftstoffSchema.optional(),
  getriebe: GetriebeSchema.optional(),
  zustand: ZustandSchema.optional(),
  vorbesitzer: z.number().int().nonnegative().optional(),
  scheckheft: z.boolean().optional(),
  /** Monate bis zur nächsten HU. */
  huRestMonate: z.number().int().optional(),
  /** Akku-Gesundheit in Prozent, nur E-Auto/Hybrid. */
  akkuSohProzent: z.number().min(0).max(100).optional(),
  ausstattung: z.array(z.string()).default([]),
  farbe: z.string().optional(),
});

export type Fahrzeug = z.infer<typeof FahrzeugSchema>;

/** Merkmale, auf die sich Ankaufsregeln beziehen dürfen. */
export const REGEL_FELDER = [
  "marke",
  "modell",
  "kilometer",
  "leistungKw",
  "kraftstoff",
  "getriebe",
  "zustand",
  "vorbesitzer",
  "scheckheft",
  "huRestMonate",
  "akkuSohProzent",
  "ausstattung",
  "alterJahre",
] as const;

export type RegelFeld = (typeof REGEL_FELDER)[number];
