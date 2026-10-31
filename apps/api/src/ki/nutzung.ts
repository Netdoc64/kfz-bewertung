/** Tagessumme der KI-Kosten (UTC-Tag) aus `ki_nutzung`. */
export async function tageskostenEuro(db: D1Database): Promise<number> {
  const z = await db
    .prepare("SELECT COALESCE(SUM(kosten_euro), 0) AS summe FROM ki_nutzung WHERE am >= strftime('%Y-%m-%dT00:00:00.000Z', 'now')")
    .first<{ summe: number }>();
  return z?.summe ?? 0;
}

export interface Preise {
  eingabeEuro: number;
  ausgabeEuro: number;
}

export function kostenEuro(tokenEin: number, tokenAus: number, preise: Preise): number {
  return (tokenEin * preise.eingabeEuro + tokenAus * preise.ausgabeEuro) / 1_000_000;
}

export interface Nutzung {
  anfrageId: string | null;
  faehigkeit: string;
  modell: string;
  tokenEin: number;
  tokenAus: number;
  kostenEuro: number;
}

export async function nutzungSchreiben(db: D1Database, n: Nutzung): Promise<void> {
  await db
    .prepare("INSERT INTO ki_nutzung (anfrage_id, faehigkeit, modell, token_ein, token_aus, kosten_euro) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(n.anfrageId, n.faehigkeit, n.modell, n.tokenEin, n.tokenAus, n.kostenEuro)
    .run();
}
