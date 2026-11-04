import type { Fahrzeug } from "@kfz/shared";
import { z } from "zod";
import { haengeAn, legeAn, type AnfrageKontext, type AnfrageUmgebung } from "../anfragen/dienst.js";
import { kanalFuerKontakt } from "../anfragen/kanal.js";
import { Einstellungen } from "../einstellungen/dienst.js";
import { leseFahrzeug } from "../email/eingang.js";
import { managerZugang, type Bindings } from "../env.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { pushFuer } from "../push/index.js";
import { sende } from "../versand/index.js";

const TAG_MS = 24 * 60 * 60 * 1000;
/** Technische Grenzen für Spaltenwerte und Feldlängen, keine Fachzahlen. */
const MAX_TEXT = 5000;
const MAX_BILDER_IM_BODY = 50;

export const BildSchema = z.object({
  medientyp: z.string().trim().min(3).max(100),
  /** Base64 des Bildes. */
  daten: z.string().min(1),
  dateiname: z.string().trim().max(200).optional(),
});

export const NachrichtSchema = z.object({
  nachrichtId: z.string().trim().min(1).max(200),
  /** Absender, E.164 mit führendem `+`. */
  von: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  name: z.string().trim().max(200).optional(),
  text: z.string().max(20000).optional(),
  bilder: z.array(BildSchema).max(MAX_BILDER_IM_BODY).optional(),
});
export type Nachricht = z.infer<typeof NachrichtSchema>;

export interface Ergebnis {
  ergebnis: "verarbeitet" | "doppelt" | "verworfen";
}

interface Besitzer {
  anfrageId?: string;
  geparktId?: string;
}

function dekodiere(b64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Legt erlaubte Bilder im R2-Bucket ab (gleiche Grenzen wie E-Mail-Anhänge); alles andere wird verworfen und protokolliert. */
async function speichereBilder(env: Bindings, einst: Einstellungen, bilder: Nachricht["bilder"], besitzer: Besitzer, korrelation: string): Promise<number> {
  const maxAnzahl = await einst.lese("mail.anhangMaxAnzahl");
  const maxBytes = await einst.lese("mail.anhangMaxBytes");
  const typen = (await einst.lese("mail.anhangTypen")).map((t) => t.toLowerCase());
  let n = 0;
  for (const b of bilder ?? []) {
    const typ = b.medientyp.toLowerCase().split(";")[0]!.trim();
    const inhalt = dekodiere(b.daten);
    const grund = n >= maxAnzahl ? "zu_viele" : !typen.includes(typ) ? "typ" : !inhalt ? "base64" : inhalt.byteLength > maxBytes ? "zu_gross" : null;
    if (grund || !inhalt) {
      console.warn("WHATSAPP_BILD_ABGELEHNT", { grund, medientyp: typ, korrelation });
      continue;
    }
    const id = crypto.randomUUID();
    const schluessel = `anhaenge/${besitzer.anfrageId ?? `geparkt-${besitzer.geparktId}`}/${id}`;
    await env.BERICHTE.put(schluessel, inhalt, { httpMetadata: { contentType: typ } });
    await env.DB.prepare("INSERT INTO email_anhaenge (id, anfrage_id, geparkt_id, r2_schluessel, dateiname, medientyp, groesse) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, besitzer.anfrageId ?? null, besitzer.geparktId ?? null, schluessel, b.dateiname?.slice(0, 200) ?? null, typ, inhalt.byteLength)
      .run();
    n += 1;
  }
  return n;
}

async function merke(db: D1Database, nachrichtId: string, b: Besitzer): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO whatsapp_eingang (nachricht_id, anfrage_id, geparkt_id) VALUES (?1, ?2, ?3)").bind(nachrichtId, b.anfrageId ?? null, b.geparktId ?? null).run();
}

/** A8: Die jüngste noch offene Anfrage derselben Nummer; WhatsApp hat keine Antwortkette, die Nummer ist der Bezug. */
async function findeOffene(db: D1Database, kontakt: string): Promise<string | null> {
  const endstatus = ["angekauft", "abgesagt", "abgelehnt"];
  const platz = endstatus.map((_, i) => `?${i + 2}`).join(",");
  const z = await db
    .prepare(`SELECT id FROM anfragen WHERE lower(kunde_kontakt) = ?1 AND status NOT IN (${platz}) ORDER BY erstellt_am DESC LIMIT 1`)
    .bind(kontakt, ...endstatus)
    .first<{ id: string }>();
  return z?.id ?? null;
}

/**
 * Wandelt eine WhatsApp-Nachricht in eine Anfrage (oder hängt sie an eine offene an, A8). Die Auslese läuft
 * ohne KI, nach den Regeln der E-Mail: nur sicher erkannte Felder. Ohne Marke und Modell wird geparkt und
 * höchstens eine Rückfrage aus der Vorlage gesendet. Antworten gehen ausschließlich durch `sende`
 * (Not-Aus, keine Preise ohne Freigabe).
 */
export async function verarbeiteWhatsapp(env: Bindings, einst: Einstellungen, n: Nachricht, korrelation: string): Promise<Ergebnis> {
  const schon = await env.DB.prepare("SELECT 1 AS x FROM whatsapp_eingang WHERE nachricht_id = ?1").bind(n.nachrichtId).first();
  if (schon) {
    console.warn("WHATSAPP_DOPPELT", { korrelation });
    return { ergebnis: "doppelt" };
  }

  const kontakt = n.von;
  const text = (n.text ?? "").trim().slice(0, MAX_TEXT);
  const name = n.name?.trim() || kontakt;
  const auslese = leseFahrzeug("", text, await einst.lese("mail.marken"), await einst.lese("mail.modellStoppwoerter"));
  const u: AnfrageUmgebung = {
    db: env.DB,
    einstellungen: einst,
    queue: env.BEWERTUNG_QUEUE,
    email: env.EMAIL,
    manager: managerZugang(env),
    push: pushFuer(env),
  };
  const k: AnfrageKontext = { kanal: "whatsapp", wer: "system", korrelation };

  const zielId = await findeOffene(env.DB, kontakt);
  if (zielId) {
    if (text !== "" || Object.keys(auslese.fahrzeug).length > 0) {
      await haengeAn(u, zielId, { text: text || kontakt, ...(Object.keys(auslese.fahrzeug).length ? { fahrzeug: auslese.fahrzeug } : {}) }, k, auslese.fahrzeug);
    }
    await speichereBilder(env, einst, n.bilder, { anfrageId: zielId }, korrelation);
    await merke(env.DB, n.nachrichtId, { anfrageId: zielId });
    return { ergebnis: "verarbeitet" };
  }

  if (!auslese.klar) {
    await parkeUnklar(env, einst, u, { kontakt, name, text, n, korrelation });
    return { ergebnis: "verarbeitet" };
  }

  const eingabe = {
    name,
    kontakt,
    fahrzeug: auslese.fahrzeug as Fahrzeug,
    ...(auslese.kennzeichen ? { kennzeichen: auslese.kennzeichen } : {}),
    ...(text ? { nachricht: text } : {}),
  };
  try {
    const r = await legeAn(u, eingabe, k);
    const besitzer: Besitzer = r.geparkt ? { geparktId: r.id } : { anfrageId: r.id };
    await speichereBilder(env, einst, n.bilder, besitzer, korrelation);
    await merke(env.DB, n.nachrichtId, besitzer);
  } catch (e) {
    // Dublette (gleiche FIN oder gleiches Kennzeichen im Fenster): die Nachricht ergänzt die vorhandene Anfrage.
    if (e instanceof AppFehler && e.code === "DUBLETTE" && typeof e.kontext?.["vorhandeneAnfrage"] === "string") {
      const id = e.kontext["vorhandeneAnfrage"];
      await haengeAn(u, id, { text: text || kontakt }, k);
      await speichereBilder(env, einst, n.bilder, { anfrageId: id }, korrelation);
      await merke(env.DB, n.nachrichtId, { anfrageId: id });
      return { ergebnis: "verarbeitet" };
    }
    throw e;
  }
  return { ergebnis: "verarbeitet" };
}

interface UnklarEingabe {
  kontakt: string;
  name: string;
  text: string;
  n: Nachricht;
  korrelation: string;
}

/** Marke/Modell nicht sicher erkannt: Nachricht parken (ein Mensch sieht sie) und, unter dem Tageslimit, einmal nachfragen. */
async function parkeUnklar(env: Bindings, einst: Einstellungen, u: AnfrageUmgebung, e: UnklarEingabe): Promise<void> {
  const max = await einst.lese("eingang.maxJeAbsenderUndTag");
  const bisher = await env.DB.prepare("SELECT COUNT(*) AS n FROM eingang_geparkt WHERE lower(kontakt) = ?1 AND erstellt_am >= ?2")
    .bind(e.kontakt, new Date(Date.now() - TAG_MS).toISOString())
    .first<{ n: number }>();
  const ueberLimit = (bisher?.n ?? 0) >= max;

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES (?1, ?2, 'whatsapp', ?3, 'whatsapp_unklar', ?4)")
    .bind(id, e.kontakt, JSON.stringify({ name: e.name, text: e.text, nachrichtId: e.n.nachrichtId }), e.korrelation)
    .run();
  await speichereBilder(env, einst, e.n.bilder, { geparktId: id }, e.korrelation);
  await merke(env.DB, e.n.nachrichtId, { geparktId: id });

  if (ueberLimit) {
    await fehlerSpeichern(env.DB, { fehler: new AppFehler("ZU_VIELE_ANFRAGEN", "Nachrichten einer Nummer über dem Tageslimit, keine Rückfrage"), ort: "whatsapp:eingang", korrelationsId: e.korrelation }, "info", env.EMAIL);
    return;
  }
  const kanal = await kanalFuerKontakt(env.EMAIL, einst, e.kontakt, u.manager);
  if (!kanal) return;
  try {
    await sende(env.DB, einst, {
      kanal,
      an: e.kontakt,
      anlass: "rueckfrage",
      werte: { name: e.name, fahrzeug: "", fehlend: "marke, modell" },
      korrelation: e.korrelation,
      schluessel: `rueckfrage-wa:${id}`,
    });
  } catch (fehler) {
    // Not-Aus „aus“ parkt die Rückfrage; alles andere ist ein Fehler für den Alarm.
    if (!(fehler instanceof AppFehler && fehler.code === "AUTOPILOT_GESPERRT")) throw fehler;
  }
}
