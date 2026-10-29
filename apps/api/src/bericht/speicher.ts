import type { Fahrzeug } from "@kfz/shared";
import { AppFehler } from "../fehler/app-fehler.js";
import type { Bewertung } from "../bewertung/bewerten.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { rendereBericht } from "./rendern.js";

export interface GespeicherterBericht {
  id: string;
  anfrageId: string;
  generation: number;
  sprache: string;
  eingabe: { fahrzeug: Fahrzeug; stichtag: string };
  vergleiche: Bewertung["vergleiche"];
  zahlen: Omit<Bewertung, "vergleiche">;
  einstellungsAbdruck: string;
  einstellungsVersionen: Record<string, number>;
  gueltigBis: string;
  html: string;
  erstelltAm: string;
  /** true, wenn dieser Aufruf den Bericht angelegt hat; false bei Wiederholung derselben Generation. */
  neu: boolean;
}

export interface BerichtSpeichern {
  anfrageId: string;
  /** Bewertungsdurchlauf der Anfrage; je Generation entsteht höchstens ein Bericht. */
  generation: number;
  fahrzeug: Fahrzeug;
  bewertung: Bewertung;
  sprache: string;
  jetzt: Date;
}

interface Zeile {
  id: string;
  anfrage_id: string;
  generation: number;
  sprache: string;
  eingabe: string;
  vergleiche: string;
  zahlen: string;
  einstellungs_abdruck: string;
  einstellungs_versionen: string;
  gueltig_bis: string;
  html_ablage: "d1" | "r2";
  html: string | null;
  r2_schluessel: string | null;
  erstellt_am: string;
}

const r2Schluessel = (anfrageId: string, generation: number) => `berichte/${anfrageId}/${generation}.html`;
const TAG_MS = 86_400_000;

async function ausZeile(z: Zeile, r2: R2Bucket | undefined, neu: boolean): Promise<GespeicherterBericht> {
  let html = z.html;
  if (z.html_ablage === "r2") {
    const obj = z.r2_schluessel && r2 ? await r2.get(z.r2_schluessel) : null;
    if (!obj) throw new AppFehler("BERICHT_FEHLT", undefined, { kontext: { anfrageId: z.anfrage_id, generation: z.generation } });
    html = await obj.text();
  }
  return {
    id: z.id,
    anfrageId: z.anfrage_id,
    generation: z.generation,
    sprache: z.sprache,
    eingabe: JSON.parse(z.eingabe),
    vergleiche: JSON.parse(z.vergleiche),
    zahlen: JSON.parse(z.zahlen),
    einstellungsAbdruck: z.einstellungs_abdruck,
    einstellungsVersionen: JSON.parse(z.einstellungs_versionen),
    gueltigBis: z.gueltig_bis,
    html: html ?? "",
    erstelltAm: z.erstellt_am,
    neu,
  };
}

async function zeile(db: D1Database, anfrageId: string, generation: number): Promise<Zeile | null> {
  return db.prepare("SELECT * FROM berichte WHERE anfrage_id = ?1 AND generation = ?2").bind(anfrageId, generation).first<Zeile>();
}

/**
 * Rendert und speichert den Bericht. Mit `r2` liegt das HTML im Bucket, sonst in D1.
 * Dieselbe (Anfrage, Generation) ein zweites Mal zu speichern liefert den vorhandenen
 * Bericht unverändert zurück (`neu: false`).
 */
export async function berichtSpeichern(
  db: D1Database,
  einstellungen: Pick<Einstellungen, "lese" | "abdruck">,
  eingabe: BerichtSpeichern,
  r2?: R2Bucket,
): Promise<GespeicherterBericht> {
  const vorhanden = await zeile(db, eingabe.anfrageId, eingabe.generation);
  if (vorhanden) return ausZeile(vorhanden, r2, false);

  const [vorlagen, tage, stand] = await Promise.all([
    einstellungen.lese("bericht.vorlagen"),
    einstellungen.lese("ablauf.berichtGueltigTage"),
    einstellungen.abdruck(),
  ]);
  const gueltigBis = new Date(eingabe.jetzt.getTime() + tage * TAG_MS);
  const gerendert = rendereBericht({
    fahrzeug: eingabe.fahrzeug,
    bewertung: eingabe.bewertung,
    vorlagen,
    sprache: eingabe.sprache,
    gueltigBis,
  });
  const { vergleiche, ...zahlen } = eingabe.bewertung;
  const schluessel = r2Schluessel(eingabe.anfrageId, eingabe.generation);
  // Vor der Zeile: bricht D1 ab, bleibt höchstens ein überschreibbares Objekt zurück.
  if (r2) await r2.put(schluessel, gerendert.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO berichte (id, anfrage_id, generation, sprache, eingabe, vergleiche, zahlen, einstellungs_abdruck,
         einstellungs_versionen, gueltig_bis, html_ablage, html, r2_schluessel, erstellt_am)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (anfrage_id, generation) DO NOTHING`,
    )
    .bind(
      id,
      eingabe.anfrageId,
      eingabe.generation,
      gerendert.sprache,
      JSON.stringify({ fahrzeug: eingabe.fahrzeug, stichtag: eingabe.jetzt.toISOString() }),
      JSON.stringify(vergleiche),
      JSON.stringify(zahlen),
      stand.abdruck,
      JSON.stringify(stand.versionen),
      gueltigBis.toISOString(),
      r2 ? "r2" : "d1",
      r2 ? null : gerendert.html,
      r2 ? schluessel : null,
      eingabe.jetzt.toISOString(),
    )
    .run();

  const gespeichert = await zeile(db, eingabe.anfrageId, eingabe.generation);
  if (!gespeichert) throw new AppFehler("DATENBANK", "Bericht nach dem Speichern nicht lesbar", { kontext: { anfrageId: eingabe.anfrageId } });
  return ausZeile(gespeichert, r2, gespeichert.id === id);
}

/** Neuester Bericht der Anfrage oder die gewünschte Generation; sonst BERICHT_FEHLT. */
export async function berichtLaden(db: D1Database, anfrageId: string, r2?: R2Bucket, generation?: number): Promise<GespeicherterBericht> {
  const z =
    generation === undefined
      ? await db.prepare("SELECT * FROM berichte WHERE anfrage_id = ?1 ORDER BY generation DESC LIMIT 1").bind(anfrageId).first<Zeile>()
      : await zeile(db, anfrageId, generation);
  if (!z) throw new AppFehler("BERICHT_FEHLT", undefined, { kontext: { anfrageId } });
  return ausZeile(z, r2, false);
}

/** Ein Bericht gilt bis `gueltigBis` (ablauf.berichtGueltigTage), danach muss neu bewertet werden. */
export function berichtIstGueltig(b: Pick<GespeicherterBericht, "gueltigBis">, jetzt: Date): boolean {
  return jetzt.getTime() <= Date.parse(b.gueltigBis);
}
