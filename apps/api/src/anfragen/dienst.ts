import { FahrzeugSchema, uebergang, type Ausloeser, type Fahrzeug, type Status } from "@kfz/shared";
import { z } from "zod";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { meldeFreigabe } from "../benachrichtigung/index.js";
import { AppFehler, alsAppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { sende } from "../versand/index.js";
import type { Kanal } from "../versand/kanal.js";
import { kanalFuerKontakt } from "./kanal.js";

export const AnlegenSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** E-Mail-Adresse oder Telefonnummer. */
  kontakt: z.string().trim().min(3).max(200),
  sprache: z.string().min(2).max(10).optional(),
  fahrzeug: FahrzeugSchema,
  kennzeichen: z.string().trim().min(2).max(15).optional(),
  nachricht: z.string().trim().max(5000).optional(),
});
export type AnlegenEingabe = z.infer<typeof AnlegenSchema>;

export const AnhaengenSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  /** Nachgereichte Fahrzeugangaben; nur die genannten Felder werden überschrieben. */
  fahrzeug: FahrzeugSchema.partial().optional(),
});
export type AnhaengenEingabe = z.infer<typeof AnhaengenSchema>;

/** Nachricht in der Queue `bewertung`. Ein Job mit älterer Generation als die Anfrage wird verworfen (A8). */
export interface BewertungsJob {
  art: "bewertung";
  anfrageId: string;
  generation: number;
  korrelation: string;
}

export interface AnfrageUmgebung {
  db: D1Database;
  einstellungen: Einstellungen;
  queue: Queue<unknown>;
  /** Für Alarm bei Flut und Fehlern; ohne Binding kein Alarm (Tests). */
  email?: SendEmail;
  /** Kanal für Rückfragen; Standard: E-Mail, wenn der Kontakt eine Adresse ist. */
  kanalFuer?: (kontakt: string) => Promise<Kanal | null>;
}

export interface AnfrageKontext {
  /** Eingangskanal (Spalte `anfragen.kanal`). */
  kanal: "formular" | "email" | "whatsapp" | "admin" | "app";
  /** Admin-Kennung oder "system". */
  wer: string;
  korrelation: string;
}

export interface AnfrageErgebnis {
  id: string;
  status: Status;
  generation: number;
  /** Über dem Flutschutz-Limit: gespeichert, aber keine Anfrage angelegt. */
  geparkt: boolean;
  fehlend: string[];
}

export interface Zeile {
  id: string;
  kanal: string;
  status: Status;
  version: number;
  kunde_name: string | null;
  kunde_kontakt: string | null;
  sprache: string | null;
  fahrzeug: string;
  rueckfragen: number;
  generation: number;
}

const TAG_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
/** Nur in diesen Status kann eine neue Nachricht des Kunden die Bewertung noch beeinflussen. */
const VOR_FREIGABE: readonly Status[] = ["eingegangen", "unvollstaendig", "in_bewertung"];

function dublettenSchluessel(kontakt: string, f: { fin?: string | undefined }, kennzeichen?: string): string | null {
  const k = kontakt.toLowerCase();
  if (f.fin) return `${k}|fin:${f.fin.toUpperCase()}`;
  if (kennzeichen) return `${k}|kz:${kennzeichen.toUpperCase().replace(/[\s-]/g, "")}`;
  return null;
}

async function fehlende(einstellungen: Einstellungen, fahrzeug: Fahrzeug): Promise<string[]> {
  const pflicht = await einstellungen.lese("antwort.pflichtangaben");
  return pflicht.filter((feld) => fahrzeug[feld] === undefined);
}

export async function lade(db: D1Database, id: string): Promise<Zeile> {
  const z = await db.prepare("SELECT * FROM anfragen WHERE id = ?1").bind(id).first<Zeile>();
  if (!z) throw new AppFehler("NICHT_GEFUNDEN", undefined, { kontext: { anfrageId: id } });
  return z;
}

/** Statuswechsel nur über `uebergang()`, mit Ereignis und optimistischer Sperre über `version`. */
export async function wechsle(u: AnfrageUmgebung, z: Zeile, aktion: string, durch: Ausloeser, k: AnfrageKontext, notiz?: string): Promise<void> {
  const nach = uebergang(z.status, aktion, durch);
  if (!nach) throw new AppFehler("STATUSWECHSEL_UNZULAESSIG", undefined, { kontext: { anfrageId: z.id, status: z.status, aktion } });
  const [upd] = await u.db.batch([
    u.db
      .prepare("UPDATE anfragen SET status = ?1, version = version + 1, geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2 AND version = ?3")
      .bind(nach, z.id, z.version),
    u.db
      .prepare(
        "INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, notiz, korrelation) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() > 0",
      )
      .bind(z.id, aktion, z.status, nach, durch === "system" ? "system" : k.wer, notiz ?? null, k.korrelation),
  ]);
  if (upd!.meta.changes === 0) throw new AppFehler("VERSION_KONFLIKT", undefined, { kontext: { anfrageId: z.id } });
  z.status = nach;
  z.version += 1;
  if (nach === "zur_freigabe" && u.email) {
    // A3: der Admin erfährt sofort von der offenen Freigabe; scheitert das, holt der Cron es nach.
    await meldeFreigabe(u.db, u.einstellungen, u.email, z, "neu", 0).catch((e) => meldeFehler(u, e, "anfragen:freigabe-benachrichtigung", k.korrelation));
  }
}

async function meldeFehler(u: AnfrageUmgebung, e: unknown, ort: string, korrelation: string): Promise<void> {
  await fehlerSpeichern(u.db, { fehler: alsAppFehler(e), ort, korrelationsId: korrelation }, "info", u.email);
}

async function reihEin(u: AnfrageUmgebung, z: Zeile, korrelation: string): Promise<void> {
  // Not-Aus „aus“: Eingänge werden angenommen und geparkt, nichts läuft an.
  if ((await u.einstellungen.lese("ablauf.autopilot")) === "aus") return;
  const job: BewertungsJob = { art: "bewertung", anfrageId: z.id, generation: z.generation, korrelation };
  try {
    await u.queue.send(job);
  } catch (e) {
    // Die Anfrage bleibt gespeichert; der Fehler alarmiert, statt still zu verschwinden.
    await meldeFehler(u, new AppFehler("DATENBANK", "Einreihen in die Queue bewertung fehlgeschlagen", { ursache: e }), "anfragen:einreihen", korrelation);
  }
}

async function rueckfrage(u: AnfrageUmgebung, z: Zeile, fahrzeug: Fahrzeug, fehlend: string[], k: AnfrageKontext): Promise<void> {
  const max = await u.einstellungen.lese("ablauf.maxRueckfragen");
  if (z.rueckfragen >= max) {
    await wechsle(u, z, "uebergeben", "system", k, "Rückfragen ausgeschöpft");
    return;
  }
  const kontakt = z.kunde_kontakt ?? "";
  let kanal: Kanal | null = null;
  try {
    kanal = await (u.kanalFuer ? u.kanalFuer(kontakt) : u.email ? kanalFuerKontakt(u.email, u.einstellungen, kontakt) : Promise.resolve(null));
  } catch (e) {
    await meldeFehler(u, e, "anfragen:rueckfrage", k.korrelation);
  }
  if (!kanal) {
    await wechsle(u, z, "uebergeben", "system", k, "Kein Kanal für die Rückfrage");
    return;
  }
  const nummer = z.rueckfragen + 1;
  const standardSprache = await u.einstellungen.lese("antwort.standardSprache");
  const beschriftungen = await u.einstellungen.lese("antwort.feldBeschriftungen");
  const tabelle = beschriftungen[z.sprache ?? standardSprache] ?? beschriftungen[standardSprache] ?? {};
  const fehlendText = fehlend.map((feld) => tabelle[feld] ?? feld).join(", ");
  try {
    await sende(u.db, u.einstellungen, {
      kanal,
      an: kontakt,
      anlass: "rueckfrage",
      anfrageId: z.id,
      ...(z.sprache ? { sprache: z.sprache } : {}),
      werte: { name: z.kunde_name ?? "", fahrzeug: `${fahrzeug.marke} ${fahrzeug.modell}`, fehlend: fehlendText },
      korrelation: k.korrelation,
      schluessel: `rueckfrage:${z.id}:${nummer}`,
    });
  } catch (e) {
    // Not-Aus „aus“ parkt die Rückfrage (steht in `nachrichten`); jeder andere Fehler geht an einen Menschen.
    if (!(e instanceof AppFehler && e.code === "AUTOPILOT_GESPERRT")) {
      await meldeFehler(u, e, "anfragen:rueckfrage", k.korrelation);
      await wechsle(u, z, "uebergeben", "system", k, "Rückfrage nicht versendet");
      return;
    }
  }
  await u.db.prepare("UPDATE anfragen SET rueckfragen = ?1 WHERE id = ?2").bind(nummer, z.id).run();
  z.rueckfragen = nummer;
}

/** Prüft die Pflichtangaben und leitet die Anfrage weiter: Rückfrage, Mensch oder Bewertung. */
async function leite(u: AnfrageUmgebung, z: Zeile, k: AnfrageKontext): Promise<string[]> {
  const fahrzeug = JSON.parse(z.fahrzeug) as Fahrzeug;
  const fehlend = await fehlende(u.einstellungen, fahrzeug);
  if (fehlend.length === 0) {
    if (z.status === "unvollstaendig") await wechsle(u, z, "angaben_ergaenzt", "system", k);
    await reihEin(u, z, k.korrelation);
    return [];
  }
  if (z.status === "eingegangen") await wechsle(u, z, "angaben_fehlen", "system", k, fehlend.join(", "));
  if (z.status === "unvollstaendig") await rueckfrage(u, z, fahrzeug, fehlend, k);
  return fehlend;
}

const ergebnis = (z: Zeile, fehlend: string[]): AnfrageErgebnis => ({ id: z.id, status: z.status, generation: z.generation, geparkt: false, fehlend });

/** Legt eine Anfrage an: Flutschutz, Dublettenprüfung, Pflichtangaben, dann Rückfrage oder Bewertung. */
export async function legeAn(u: AnfrageUmgebung, eingabe: AnlegenEingabe, k: AnfrageKontext): Promise<AnfrageErgebnis> {
  const kontakt = eingabe.kontakt.toLowerCase();

  // A9: Flutschutz je Absender und Tag. Admin-Eingaben sind davon ausgenommen.
  if (k.kanal !== "admin") {
    const max = await u.einstellungen.lese("eingang.maxJeAbsenderUndTag");
    const seit = iso(Date.now() - TAG_MS);
    const n = await u.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM anfragen WHERE lower(kunde_kontakt) = ?1 AND erstellt_am >= ?2)
              + (SELECT COUNT(*) FROM eingang_geparkt WHERE lower(kontakt) = ?1 AND erstellt_am >= ?2) AS n`,
      )
      .bind(kontakt, seit)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= max) {
      const id = crypto.randomUUID();
      await u.db
        .prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES (?1, ?2, ?3, ?4, 'flutschutz', ?5)")
        .bind(id, eingabe.kontakt, k.kanal, JSON.stringify(eingabe), k.korrelation)
        .run();
      await meldeFehler(u, new AppFehler("ZU_VIELE_ANFRAGEN", "Eingang eines Absenders über dem Tageslimit geparkt"), "anfragen:flutschutz", k.korrelation);
      return { id, status: "eingegangen", generation: 0, geparkt: true, fehlend: [] };
    }
  }

  const schluessel = dublettenSchluessel(eingabe.kontakt, eingabe.fahrzeug, eingabe.kennzeichen);
  if (schluessel) {
    const tage = await u.einstellungen.lese("ablauf.dublettenFensterTage");
    const alt = await u.db
      .prepare("SELECT id FROM anfragen WHERE dubletten_schluessel = ?1 AND erstellt_am >= ?2 LIMIT 1")
      .bind(schluessel, iso(Date.now() - tage * TAG_MS))
      .first<{ id: string }>();
    if (alt) throw new AppFehler("DUBLETTE", undefined, { kontext: { vorhandeneAnfrage: alt.id } });
  }

  const id = crypto.randomUUID();
  await u.db.batch([
    u.db
      .prepare("INSERT INTO anfragen (id, kanal, status, kunde_name, kunde_kontakt, sprache, fahrzeug, dubletten_schluessel) VALUES (?1, ?2, 'eingegangen', ?3, ?4, ?5, ?6, ?7)")
      .bind(id, k.kanal, eingabe.name, eingabe.kontakt, eingabe.sprache ?? null, JSON.stringify(eingabe.fahrzeug), schluessel),
    u.db
      .prepare("INSERT INTO anfrage_ereignisse (anfrage_id, aktion, status_von, status_nach, durch, korrelation) VALUES (?1, 'angelegt', NULL, 'eingegangen', ?2, ?3)")
      .bind(id, k.wer, k.korrelation),
    ...(eingabe.nachricht
      ? [u.db.prepare("INSERT INTO anfrage_nachrichten (anfrage_id, kanal, text, generation, korrelation) VALUES (?1, ?2, ?3, 1, ?4)").bind(id, k.kanal, eingabe.nachricht, k.korrelation)]
      : []),
  ]);

  const z = await lade(u.db, id);
  const fehlend = await leite(u, z, k);
  return ergebnis(z, fehlend);
}

/**
 * Hängt eine weitere Nachricht des Kunden an (A8). Vor der Freigabe erhöht das die
 * Generation, sodass ein laufender Bewertungsjob verworfen und mit dem neuen Stand
 * neu eingereiht wird. `rohFahrzeug` ist das unveränderte Eingabeobjekt: nur dessen
 * Felder überschreiben die gespeicherten (das Schema füllt sonst Standardwerte auf).
 */
export async function haengeAn(u: AnfrageUmgebung, id: string, eingabe: AnhaengenEingabe, k: AnfrageKontext, rohFahrzeug?: object): Promise<AnfrageErgebnis> {
  const z = await lade(u.db, id);
  const bump = VOR_FREIGABE.includes(z.status);
  const generation = bump ? z.generation + 1 : z.generation;

  const nur = rohFahrzeug ? new Set(Object.keys(rohFahrzeug)) : new Set<string>();
  const neu = Object.fromEntries(Object.entries(eingabe.fahrzeug ?? {}).filter(([feld]) => nur.has(feld)));
  const fahrzeug = { ...(JSON.parse(z.fahrzeug) as object), ...neu };

  const [upd] = await u.db.batch([
    u.db
      .prepare("UPDATE anfragen SET fahrzeug = ?1, generation = ?2, version = version + 1, geaendert_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?3 AND version = ?4")
      .bind(JSON.stringify(fahrzeug), generation, id, z.version),
    u.db
      .prepare("INSERT INTO anfrage_nachrichten (anfrage_id, kanal, text, generation, korrelation) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() > 0")
      .bind(id, k.kanal, eingabe.text, generation, k.korrelation),
  ]);
  if (upd!.meta.changes === 0) throw new AppFehler("VERSION_KONFLIKT", undefined, { kontext: { anfrageId: id } });
  z.fahrzeug = JSON.stringify(fahrzeug);
  z.generation = generation;
  z.version += 1;

  const fehlend = bump ? await leite(u, z, k) : [];
  return ergebnis(z, fehlend);
}
