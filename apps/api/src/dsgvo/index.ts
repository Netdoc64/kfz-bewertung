import { AppFehler } from "../fehler/app-fehler.js";

/** Welche Zeilen zu einer Person gehören: Anfragen und geparkte Eingänge. */
export interface PersonenBezug {
  anfrageIds: string[];
  geparktIds: string[];
}

export interface LoeschErgebnis {
  anfragen: number;
  geparkt: number;
  anhaenge: number;
  berichte: number;
}

const R2_STAPEL = 1000;
const einheitlich = (kontakt: string) => kontakt.trim().toLowerCase();

/** Alle Zeilen zu einem Kontakt (Groß-/Kleinschreibung egal). Leer = die Person ist nicht (mehr) bekannt. */
export async function findePerson(db: D1Database, kontakt: string, maxAnfragen: number): Promise<PersonenBezug & { abgeschnitten: boolean }> {
  const k = einheitlich(kontakt);
  const [a, g] = await Promise.all([
    db.prepare("SELECT id FROM anfragen WHERE lower(trim(kunde_kontakt)) = ?1 ORDER BY erstellt_am, id LIMIT ?2").bind(k, maxAnfragen + 1).all<{ id: string }>(),
    db.prepare("SELECT id FROM eingang_geparkt WHERE lower(trim(kontakt)) = ?1 ORDER BY erstellt_am, id LIMIT ?2").bind(k, maxAnfragen + 1).all<{ id: string }>(),
  ]);
  const abgeschnitten = a.results.length > maxAnfragen || g.results.length > maxAnfragen;
  return { anfrageIds: a.results.slice(0, maxAnfragen).map((r) => r.id), geparktIds: g.results.slice(0, maxAnfragen).map((r) => r.id), abgeschnitten };
}

/** Auskunft (Art. 15): alles, was zu den Zeilen gespeichert ist. Anhänge und Berichts-HTML nur als Verzeichnis, nicht als Inhalt. */
export async function sammleAuskunft(db: D1Database, kontakt: string, bezug: PersonenBezug) {
  const a = JSON.stringify(bezug.anfrageIds);
  const g = JSON.stringify(bezug.geparktIds);
  const k = einheitlich(kontakt);
  const t = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all()).results;
  const inA = "IN (SELECT value FROM json_each(?1))";
  return {
    anfragen: await t(
      `SELECT id, kanal, status, kunde_name, kunde_kontakt, sprache, fahrzeug, rueckfragen, erstellt_am, geaendert_am, personendaten_geloescht_am FROM anfragen WHERE id ${inA} ORDER BY erstellt_am, id`,
      a,
    ),
    nachrichtenVomKunden: await t(`SELECT id, anfrage_id, kanal, text, erstellt_am FROM anfrage_nachrichten WHERE anfrage_id ${inA} ORDER BY id`, a),
    ereignisse: await t(`SELECT anfrage_id, aktion, status_von, status_nach, notiz, am FROM anfrage_ereignisse WHERE anfrage_id ${inA} ORDER BY id`, a),
    versandteNachrichten: await t(
      `SELECT id, anfrage_id, kontakt, kanal, anlass, sprache, inhalt, status, erstellt_am FROM nachrichten WHERE anfrage_id ${inA} OR lower(trim(kontakt)) = ?2 ORDER BY erstellt_am, id`,
      a,
      k,
    ),
    geparkteEingaenge: await t(
      `SELECT id, kontakt, kanal, nutzlast, grund, erstellt_am, entscheidung FROM eingang_geparkt WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY erstellt_am, id`,
      g,
    ),
    emailEingang: await t(
      `SELECT message_id, anfrage_id, geparkt_id, erstellt_am FROM email_eingang WHERE anfrage_id ${inA} OR geparkt_id IN (SELECT value FROM json_each(?2)) ORDER BY erstellt_am`,
      a,
      g,
    ),
    anhaenge: await t(
      `SELECT id, anfrage_id, geparkt_id, dateiname, medientyp, groesse, erstellt_am FROM email_anhaenge WHERE anfrage_id ${inA} OR geparkt_id IN (SELECT value FROM json_each(?2)) ORDER BY erstellt_am, id`,
      a,
      g,
    ),
    berichte: await t(`SELECT id, anfrage_id, generation, sprache, eingabe, zahlen, erstellt_am, gueltig_bis FROM berichte WHERE anfrage_id ${inA} ORDER BY anfrage_id, generation`, a),
    ankaeufe: await t(`SELECT anfrage_id, marke, preis_euro, erfasst_am FROM ankaeufe WHERE anfrage_id ${inA}`, a),
  };
}

/**
 * Löscht die Personendaten zu den Zeilen: Speicherobjekte zuerst (ein Fehler lässt die Datenbank
 * unberührt und den Vorgang wiederholbar), dann alles in einem Batch. Die Anfrage selbst bleibt anonym
 * erhalten, `personendaten_geloescht_am` macht einen zweiten Lauf zum No-op.
 */
export async function loeschePersonendaten(
  db: D1Database,
  r2: R2Bucket | undefined,
  bezug: PersonenBezug,
  opt: { durch: string; jetzt?: number; kontakt?: string },
): Promise<LoeschErgebnis> {
  if (bezug.anfrageIds.length === 0 && bezug.geparktIds.length === 0) return { anfragen: 0, geparkt: 0, anhaenge: 0, berichte: 0 };
  const a = JSON.stringify(bezug.anfrageIds);
  const g = JSON.stringify(bezug.geparktIds);
  const jetztIso = new Date(opt.jetzt ?? Date.now()).toISOString();
  const inA = "IN (SELECT value FROM json_each(?1))";
  const inG = "IN (SELECT value FROM json_each(?2))";

  const anhangZeilen = await db.prepare(`SELECT r2_schluessel FROM email_anhaenge WHERE anfrage_id ${inA} OR geparkt_id ${inG}`).bind(a, g).all<{ r2_schluessel: string }>();
  const berichtZeilen = await db
    .prepare(`SELECT r2_schluessel FROM berichte WHERE html_ablage = 'r2' AND r2_schluessel IS NOT NULL AND anfrage_id ${inA}`)
    .bind(a)
    .all<{ r2_schluessel: string }>();
  const schluessel = [...anhangZeilen.results, ...berichtZeilen.results].map((z) => z.r2_schluessel);
  if (schluessel.length > 0) {
    if (!r2) throw new AppFehler("DSGVO_LOESCHUNG_FEHLGESCHLAGEN", "Kein Speicher für Anhänge und Berichte verfügbar", { kontext: { objekte: schluessel.length } });
    try {
      for (let i = 0; i < schluessel.length; i += R2_STAPEL) await r2.delete(schluessel.slice(i, i + R2_STAPEL));
    } catch (e) {
      throw new AppFehler("DSGVO_LOESCHUNG_FEHLGESCHLAGEN", "Anhänge oder Berichte konnten nicht aus dem Speicher gelöscht werden", { ursache: e, kontext: { objekte: schluessel.length } });
    }
  }

  const kontakt = opt.kontakt === undefined ? "" : einheitlich(opt.kontakt);
  const stmts = [
    // Versandprotokoll: zur Anfrage oder (bei Einzellöschung) über den Kontakt, auch ohne Anfrage.
    db.prepare(`UPDATE nachrichten SET kontakt = '', inhalt = '' WHERE anfrage_id ${inA} OR (?3 <> '' AND lower(trim(kontakt)) = ?3)`).bind(a, g, kontakt),
    db.prepare(`DELETE FROM anfrage_nachrichten WHERE anfrage_id ${inA}`).bind(a),
    db.prepare(`UPDATE anfrage_ereignisse SET notiz = NULL WHERE notiz IS NOT NULL AND anfrage_id ${inA}`).bind(a),
    db.prepare(`DELETE FROM email_anhaenge WHERE anfrage_id ${inA} OR geparkt_id ${inG}`).bind(a, g),
    db.prepare(`DELETE FROM email_eingang WHERE anfrage_id ${inA} OR geparkt_id ${inG}`).bind(a, g),
    db.prepare(`UPDATE berichte SET html = NULL, r2_schluessel = NULL WHERE anfrage_id ${inA} AND (html IS NOT NULL OR r2_schluessel IS NOT NULL)`).bind(a),
    // Spur der Löschung ohne Personenbezug: Anfrage, Zeitpunkt (Spalte `am`) und Admin. Muss vor dem Marker laufen.
    db
      .prepare(
        `INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, korrelation) SELECT id, 'dsgvo_geloescht', status, status, ?2, 'dsgvo' FROM anfragen WHERE id ${inA} AND personendaten_geloescht_am IS NULL`,
      )
      .bind(a, opt.durch),
    db
      .prepare(`UPDATE anfragen SET kunde_name = NULL, kunde_kontakt = NULL, dubletten_schluessel = NULL, personendaten_geloescht_am = ?2 WHERE id ${inA} AND personendaten_geloescht_am IS NULL`)
      .bind(a, jetztIso),
    db.prepare("DELETE FROM eingang_geparkt WHERE id IN (SELECT value FROM json_each(?1))").bind(g),
  ];
  const erg = await db.batch(stmts);
  const anf = erg[7]!;
  const geparkt = erg[8]!;
  return { anfragen: anf.meta.changes, geparkt: geparkt.meta.changes, anhaenge: anhangZeilen.results.length, berichte: berichtZeilen.results.length };
}
