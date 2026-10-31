/** Rohformat der Mock-Datenquelle (so ähnlich liefert mobile.de es). Wird beim Lesen mit zod geprüft. */
export interface MockSegment {
  schluessel: string;
  inserate: unknown[];
}
