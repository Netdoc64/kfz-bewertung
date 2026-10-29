import type { Einstellungen } from "../einstellungen/dienst.js";

/** Ergebnis einer Aufgabe: wie viele Zeilen sie angefasst hat, optional mit Hinweis. */
export interface AufgabenErgebnis {
  bearbeitet: number;
  notiz?: string;
  /** true: Aufgabe hat bewusst nichts getan (z. B. Mock-Modus). */
  uebersprungen?: boolean;
}

const MS_STUNDE = 3_600_000;
const MS_TAG = 24 * MS_STUNDE;
const ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Rückfrage ohne Antwort: Anfragen im Status „unvollstaendig“ gehen nach
 * `ablauf.rueckfrageTimeoutStunden` an einen Menschen. Der Wechsel prüft Status und
 * Version, ein zweiter Lauf findet nichts mehr.
 */
export async function rueckfrageTimeout(db: D1Database, einstellungen: Einstellungen, korrelation: string, jetzt = Date.now()): Promise<AufgabenErgebnis> {
  const stunden = await einstellungen.lese("ablauf.rueckfrageTimeoutStunden");
  const grenze = new Date(jetzt - stunden * MS_STUNDE).toISOString();
  const { results } = await db
    .prepare("SELECT id, version FROM anfragen WHERE status = 'unvollstaendig' AND geaendert_am <= ?1")
    .bind(grenze)
    .all<{ id: string; version: number }>();
  let n = 0;
  for (const r of results) {
    const [upd] = await db.batch([
      db
        .prepare(`UPDATE anfragen SET status = 'an_mensch', version = version + 1, geaendert_am = ${ISO} WHERE id = ?1 AND version = ?2 AND status = 'unvollstaendig'`)
        .bind(r.id, r.version),
      db
        .prepare(
          "INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, notiz, korrelation) SELECT ?1, 'uebergeben', 'unvollstaendig', 'an_mensch', 'system', ?2, ?3 WHERE changes() > 0",
        )
        .bind(r.id, `Rückfrage ohne Antwort nach ${stunden} Stunden`, korrelation),
    ]);
    n += upd!.meta.changes;
  }
  return { bearbeitet: n };
}

/**
 * Berichtsablauf: abgelaufene Berichte werden einmal markiert. Liegt der gültige Bericht
 * einer Anfrage in „zur_freigabe“ über der Frist, geht sie mit Grund an einen Menschen —
 * ein abgelaufener Bericht wird nie still freigegeben.
 */
export async function berichtsablauf(db: D1Database, korrelation: string, jetzt = Date.now()): Promise<AufgabenErgebnis> {
  const jetztIso = new Date(jetzt).toISOString();
  const { results } = await db
    .prepare(
      `SELECT a.id, a.version FROM anfragen a
       WHERE a.status = 'zur_freigabe'
         AND NOT EXISTS (SELECT 1 FROM berichte b WHERE b.anfrage_id = a.id AND b.generation = a.generation AND b.gueltig_bis > ?1)
         AND EXISTS (SELECT 1 FROM berichte b WHERE b.anfrage_id = a.id AND b.generation = a.generation)`,
    )
    .bind(jetztIso)
    .all<{ id: string; version: number }>();
  let n = 0;
  for (const r of results) {
    const [upd] = await db.batch([
      db
        .prepare(`UPDATE anfragen SET status = 'an_mensch', version = version + 1, geaendert_am = ${ISO} WHERE id = ?1 AND version = ?2 AND status = 'zur_freigabe'`)
        .bind(r.id, r.version),
      db
        .prepare(
          "INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, notiz, korrelation) SELECT ?1, 'uebergeben', 'zur_freigabe', 'an_mensch', 'system', 'Bericht abgelaufen, neu bewerten', ?2 WHERE changes() > 0",
        )
        .bind(r.id, korrelation),
    ]);
    n += upd!.meta.changes;
  }
  const mark = await db.prepare("UPDATE berichte SET abgelaufen_am = ?1 WHERE abgelaufen_am IS NULL AND gueltig_bis <= ?1").bind(jetztIso).run();
  return { bearbeitet: n + mark.meta.changes };
}

/**
 * DSGVO-Löschung: Kundendaten abgeschlossener Anfragen (Endstatus) werden nach
 * `betrieb.personendatenAufbewahrungTage` entfernt, die Anfrage selbst bleibt anonym
 * erhalten. Geparkte Eingänge gelten ab Erstellung. Alles in einem Batch; der
 * Marker `personendaten_geloescht_am` macht den zweiten Lauf zum No-op.
 */
export async function dsgvoLoeschung(db: D1Database, einstellungen: Einstellungen, jetzt = Date.now()): Promise<AufgabenErgebnis> {
  const tage = await einstellungen.lese("betrieb.personendatenAufbewahrungTage");
  const grenze = new Date(jetzt - tage * MS_TAG).toISOString();
  const jetztIso = new Date(jetzt).toISOString();
  const faellig = "FROM anfragen WHERE status IN ('angekauft', 'abgesagt', 'abgelehnt') AND personendaten_geloescht_am IS NULL AND geaendert_am <= ?1";
  const [, , , anf, geparkt] = await db.batch([
    db.prepare(`UPDATE nachrichten SET kontakt = '', inhalt = '' WHERE anfrage_id IN (SELECT id ${faellig})`).bind(grenze),
    db.prepare(`DELETE FROM anfrage_nachrichten WHERE anfrage_id IN (SELECT id ${faellig})`).bind(grenze),
    db.prepare(`UPDATE anfrage_ereignisse SET notiz = NULL WHERE notiz IS NOT NULL AND anfrage_id IN (SELECT id ${faellig})`).bind(grenze),
    db
      .prepare(
        `UPDATE anfragen SET kunde_name = NULL, kunde_kontakt = NULL, dubletten_schluessel = NULL, personendaten_geloescht_am = ?2 WHERE id IN (SELECT id ${faellig})`,
      )
      .bind(grenze, jetztIso),
    db.prepare("DELETE FROM eingang_geparkt WHERE erstellt_am <= ?1").bind(grenze),
  ]);
  return { bearbeitet: anf!.meta.changes + geparkt!.meta.changes };
}

/** Fehleraufräumen: Fehlereinträge, Alarm-Ruhezeiten und alte Cron-Läufe nach `betrieb.fehlerAufbewahrungTage`. */
export async function fehlerAufraeumen(db: D1Database, einstellungen: Einstellungen, jetzt = Date.now()): Promise<AufgabenErgebnis> {
  const tage = await einstellungen.lese("betrieb.fehlerAufbewahrungTage");
  const grenze = new Date(jetzt - tage * MS_TAG).toISOString();
  const [fehler, ruhe, laeufe] = await db.batch([
    db.prepare("DELETE FROM fehler_ereignisse WHERE zuletzt <= ?1").bind(grenze),
    db.prepare("DELETE FROM alarm_ruhe WHERE zuletzt_alarmiert <= ?1").bind(grenze),
    db.prepare("DELETE FROM cron_laeufe WHERE beginn <= ?1").bind(grenze),
  ]);
  return { bearbeitet: fehler!.meta.changes + ruhe!.meta.changes + laeufe!.meta.changes };
}

/** Referenzdaten-Abgleich: im Mock-Modus ein protokollierter No-op, live noch nicht angeschlossen. */
export async function referenzAbgleich(einstellungen: Einstellungen): Promise<AufgabenErgebnis> {
  const modus = await einstellungen.lese("quelle.mobilede.modus");
  if (modus === "mock") return { bearbeitet: 0, uebersprungen: true, notiz: "Mock-Modus: kein Abgleich" };
  return { bearbeitet: 0, uebersprungen: true, notiz: "Live-Abgleich noch nicht angeschlossen (Phase 4)" };
}
