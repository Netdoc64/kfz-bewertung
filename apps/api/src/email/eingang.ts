import { FahrzeugSchema, type AuslesenErgebnis, type Einordnung, type Fahrzeug } from "@kfz/shared";
import PostalMime, { type Attachment, type Email } from "postal-mime";
import { kiFuer, type KiAbhaengigkeiten } from "../ki/index.js";
import { haengeAn, legeAn, type AnfrageKontext, type AnfrageUmgebung } from "../anfragen/dienst.js";
import { pushFuer } from "../push/index.js";
import type { Bindings } from "../env.js";
import { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { fehlerSpeichern } from "../fehler/speicher.js";
import { sende } from "../versand/index.js";
import { EmailKanal, type MailBezug } from "./versand.js";

const TAG_MS = 24 * 60 * 60 * 1000;
/** Technische Grenze für Spaltenwerte, keine Fachzahl. */
const MAX_TEXT = 5000;

export interface MailAuslese {
  /** Nur die sicher erkannten Felder; nichts wird geraten. */
  fahrzeug: Partial<Fahrzeug>;
  kennzeichen?: string;
  /** Marke und Modell, falls beides sicher erkannt wurde. */
  klar: boolean;
}

const norm = (id: string) => id.trim().replace(/^<|>$/g, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Entfernt zitierte Zeilen („> …“) und Signaturtrenner; der Rest ist der neue Text des Kunden. */
export function neuerText(text: string): string {
  const zeilen: string[] = [];
  for (const z of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (z.trim() === "--") break;
    if (/^\s*>/.test(z)) continue;
    zeilen.push(z);
  }
  return zeilen.join("\n").trim();
}

/**
 * Liest Fahrzeugangaben regelbasiert aus Betreff und Text. Der Text ist nur Daten:
 * er wird mit Mustern durchsucht, nie ausgeführt oder als Anweisung gelesen.
 * Mehrdeutige Marken (zwei verschiedene) ergeben „unklar“ statt einer Vermutung.
 */
export function leseFahrzeug(betreff: string, text: string, marken: string[], stoppwoerter: string[]): MailAuslese {
  const quelle = `${betreff}\n${text}`;
  const fahrzeug: Partial<Fahrzeug> = {};

  const gefunden = marken
    .map((m) => ({ marke: m, treffer: new RegExp(`(?<![\\p{L}\\d])${escape(m)}(?![\\p{L}\\d])`, "iu").exec(quelle) }))
    .filter((x): x is { marke: string; treffer: RegExpExecArray } => x.treffer !== null);
  // „VW“ und „Volkswagen“ in einer Mail sind dieselbe Marke nur, wenn die Liste sie so führt; sonst unklar.
  const markenTreffer = new Set(gefunden.map((x) => x.marke.toLowerCase()));
  if (markenTreffer.size === 1) {
    const { marke, treffer } = gefunden[0]!;
    const rest = quelle.slice(treffer.index + treffer[0].length);
    const modell = /^[ \t]+([\p{L}\d][\p{L}\d-]*)/u.exec(rest)?.[1];
    if (modell && !stoppwoerter.includes(modell.toLowerCase()) && !/^\d{4,}$/.test(modell)) {
      fahrzeug.marke = marke;
      fahrzeug.modell = modell;
    }
  }

  const km = /(\d{1,3}(?:[. ]\d{3})+|\d+)\s*(?:km|kilometer)\b/i.exec(quelle)?.[1];
  if (km) fahrzeug.kilometer = Number(km.replace(/[. ]/g, ""));

  const ez = /(?:\bEZ|erstzulassung)\s*:?\s*(\d{1,2})[/.](\d{4})\b/i.exec(quelle);
  if (ez) fahrzeug.erstzulassung = `${ez[2]}-${ez[1]!.padStart(2, "0")}`;

  const fin = (quelle.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) ?? []).find((k) => /\d/.test(k) && /[A-Z]/.test(k));
  if (fin) fahrzeug.fin = fin;

  // Jedes Feld einzeln gegen das Schema prüfen: ein ungültiges Feld wird verworfen, nicht geraten.
  for (const feld of Object.keys(fahrzeug) as Array<keyof Fahrzeug>) {
    const p = FahrzeugSchema.shape[feld].safeParse(fahrzeug[feld]);
    if (p.success) (fahrzeug as Record<string, unknown>)[feld] = p.data;
    else delete fahrzeug[feld];
  }

  const kennzeichen = /kennzeichen\s*:?\s*([A-ZÄÖÜ]{1,3}[- ][A-Z]{1,2}[ -]?\d{1,4}[EH]?)\b/.exec(quelle)?.[1];
  return { fahrzeug, ...(kennzeichen ? { kennzeichen } : {}), klar: fahrzeug.marke !== undefined && fahrzeug.modell !== undefined };
}

/** Message-IDs, auf die diese Mail antwortet (In-Reply-To, References), ohne spitze Klammern. */
export function bezugsIds(m: Email): string[] {
  const roh = `${m.inReplyTo ?? ""} ${m.references ?? ""}`;
  return [...new Set((roh.match(/<[^<>\s]+>|[^\s<>]+@[^\s<>]+/g) ?? []).map(norm))];
}

async function findeAntwortZiel(db: D1Database, ids: string[], absender: string): Promise<string | null> {
  if (ids.length === 0) return null;
  // Eigene Versandnachrichten kennen die Message-ID mit und ohne Klammern.
  const mitKlammern = [...ids, ...ids.map((i) => `<${i}>`)];
  const m2 = mitKlammern.map((_, i) => `?${i + 1}`).join(",");
  const aus = await db
    .prepare(
      `SELECT a.id FROM nachrichten n JOIN anfragen a ON a.id = n.anfrage_id WHERE n.externe_id IN (${m2}) AND lower(a.kunde_kontakt) = ?${mitKlammern.length + 1} LIMIT 1`,
    )
    .bind(...mitKlammern, absender)
    .first<{ id: string }>();
  if (aus) return aus.id;
  const ein = await db
    .prepare(`SELECT a.id FROM email_eingang x JOIN anfragen a ON a.id = x.anfrage_id WHERE x.message_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")}) AND lower(a.kunde_kontakt) = ?${ids.length + 1} LIMIT 1`)
    .bind(...ids, absender)
    .first<{ id: string }>();
  return ein?.id ?? null;
}

async function leseRoh(nachricht: ForwardableEmailMessage, max: number): Promise<ArrayBuffer> {
  if (!nachricht.raw) throw new AppFehler("MAIL_UNGUELTIG", "Mail ohne Rohdaten");
  if (nachricht.rawSize > max) throw new AppFehler("MAIL_UNGUELTIG", "Mail zu groß", { kontext: { groesse: nachricht.rawSize } });
  return new Response(nachricht.raw).arrayBuffer();
}

async function parse(roh: ArrayBuffer): Promise<Email> {
  try {
    return await PostalMime.parse(roh);
  } catch (e) {
    throw new AppFehler("MAIL_UNGUELTIG", "MIME nicht lesbar", { ursache: e });
  }
}

interface Besitzer {
  anfrageId?: string;
  geparktId?: string;
}

/** Legt erlaubte Anhänge im R2-Bucket ab und ordnet sie zu; alles andere wird verworfen und protokolliert. */
async function speichereAnhaenge(env: Bindings, einst: Einstellungen, anhaenge: Attachment[], besitzer: Besitzer, korrelation: string): Promise<number> {
  const maxAnzahl = await einst.lese("mail.anhangMaxAnzahl");
  const maxBytes = await einst.lese("mail.anhangMaxBytes");
  const typen = (await einst.lese("mail.anhangTypen")).map((t) => t.toLowerCase());
  let n = 0;
  for (const a of anhaenge) {
    const inhalt = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
    const typ = (a.mimeType ?? "").toLowerCase().split(";")[0]!.trim();
    const grund = n >= maxAnzahl ? "zu_viele" : !typen.includes(typ) ? "typ" : inhalt.byteLength > maxBytes ? "zu_gross" : null;
    if (grund) {
      console.warn("EMAIL_ANHANG_ABGELEHNT", { grund, medientyp: typ, groesse: inhalt.byteLength, korrelation });
      continue;
    }
    const id = crypto.randomUUID();
    const schluessel = `anhaenge/${besitzer.anfrageId ?? `geparkt-${besitzer.geparktId}`}/${id}`;
    await env.BERICHTE.put(schluessel, inhalt, { httpMetadata: { contentType: typ } });
    await env.DB.prepare("INSERT INTO email_anhaenge (id, anfrage_id, geparkt_id, r2_schluessel, dateiname, medientyp, groesse) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, besitzer.anfrageId ?? null, besitzer.geparktId ?? null, schluessel, a.filename?.slice(0, 200) ?? null, typ, inhalt.byteLength)
      .run();
    n += 1;
  }
  return n;
}

async function merke(db: D1Database, messageId: string | undefined, b: Besitzer): Promise<void> {
  if (!messageId) return;
  await db
    .prepare("INSERT OR IGNORE INTO email_eingang (message_id, anfrage_id, geparkt_id) VALUES (?1, ?2, ?3)")
    .bind(norm(messageId), b.anfrageId ?? null, b.geparktId ?? null)
    .run();
}

/**
 * Wandelt eine Kundenmail in eine Anfrage (oder hängt sie an eine bestehende an, A8).
 * Der Schleifenschutz hat vorher entschieden; hier wird nur noch gelesen.
 * Ohne sicher erkannte Marke und Modell wird die Mail geparkt und höchstens
 * eine Rückfrage gesendet, statt zu raten.
 */
export async function verarbeiteEingang(nachricht: ForwardableEmailMessage, env: Bindings, einst: Einstellungen, korrelation: string, ki: KiAbhaengigkeiten = {}): Promise<void> {
  const roh = await leseRoh(nachricht, await einst.lese("mail.maxGroesseBytes"));
  const mail = await parse(roh);

  const absender = (mail.from?.address ?? nachricht.from ?? "").trim().toLowerCase();
  if (!absender.includes("@")) throw new AppFehler("MAIL_UNGUELTIG", "Kein Absender erkennbar");
  const betreff = (mail.subject ?? "").trim();
  const text = neuerText(mail.text ?? "").slice(0, MAX_TEXT);

  // Erneute Zustellung derselben Mail ergibt nichts Neues.
  if (mail.messageId) {
    const schon = await env.DB.prepare("SELECT 1 AS x FROM email_eingang WHERE message_id = ?1").bind(norm(mail.messageId)).first();
    if (schon) {
      console.warn("EMAIL_DOPPELT", { korrelation });
      return;
    }
  }

  const regelAuslese = leseFahrzeug(betreff, text, await einst.lese("mail.marken"), await einst.lese("mail.modellStoppwoerter"));
  const bezug: MailBezug = {
    messageId: mail.messageId ?? "",
    ...(mail.references ? { references: mail.references } : {}),
    ...(betreff ? { betreff } : {}),
  };
  const u: AnfrageUmgebung = {
    db: env.DB,
    einstellungen: einst,
    queue: env.BEWERTUNG_QUEUE,
    push: pushFuer(env),
    email: env.EMAIL,
    kanalFuer: async (kontakt) => (kontakt.includes("@") ? new EmailKanal(env.EMAIL, einst, bezug.messageId ? bezug : undefined) : null),
  };
  const k: AnfrageKontext = { kanal: "email", wer: "system", korrelation };
  const anhaenge = mail.attachments ?? [];

  // A8: Antwort auf eine bekannte Anfrage desselben Absenders hängt die Nachricht an.
  const zielId = await findeAntwortZiel(env.DB, bezugsIds(mail), absender);

  // Einordnung (optional): nur ein Etikett für den Weg, nie ein Preis, ein Empfänger oder ein Status.
  // null (KI aus, Fehler, refusal, Budget) heißt: der regelbasierte Weg unten, unverändert.
  const einordnung = await ordneEin(env, einst, betreff, text, zielId, korrelation, ki);
  if (einordnung === "spam") {
    console.warn("EMAIL_VERWORFEN", { grund: "ki_spam", korrelation });
    await merke(env.DB, mail.messageId, {});
    return;
  }
  const anMensch = einordnung === "sonstiges" ? "ki_sonstiges" : einordnung === "rueckfrage_antwort" && !zielId ? "ki_rueckfrage_unzuordenbar" : null;
  if (anMensch) {
    const nameMensch = mail.from?.name?.trim() || absender.split("@")[0]!;
    await parkeFuerMensch(env, einst, { kontakt: absender, name: nameMensch, betreff, text, anhaenge: mail.attachments ?? [], mail, korrelation }, anMensch);
    return;
  }

  const auslese = await ergaenzeDurchKi(env, einst, regelAuslese, [betreff, text].filter(Boolean).join("\n\n"), anhaenge, zielId, korrelation, ki);

  if (zielId) {
    if (text !== "" || Object.keys(auslese.fahrzeug).length > 0) {
      const fahrzeug = auslese.fahrzeug;
      await haengeAn(u, zielId, { text: text || betreff || absender, ...(Object.keys(fahrzeug).length ? { fahrzeug } : {}) }, k, fahrzeug);
    }
    await speichereAnhaenge(env, einst, anhaenge, { anfrageId: zielId }, korrelation);
    await merke(env.DB, mail.messageId, { anfrageId: zielId });
    return;
  }

  const name = mail.from?.name?.trim() || absender.split("@")[0]!;
  const kontakt = absender;

  if (!auslese.klar) {
    await parkeUnklar(env, einst, u, { kontakt, name, betreff, text, anhaenge, mail, bezug, korrelation });
    return;
  }

  const eingabe = {
    name,
    kontakt,
    fahrzeug: auslese.fahrzeug as Fahrzeug,
    ...(auslese.kennzeichen ? { kennzeichen: auslese.kennzeichen } : {}),
    nachricht: [betreff, text].filter(Boolean).join("\n\n").slice(0, MAX_TEXT) || undefined,
  };
  const eingabeOhneLeer = Object.fromEntries(Object.entries(eingabe).filter(([, v]) => v !== undefined)) as typeof eingabe;

  try {
    const r = await legeAn(u, eingabeOhneLeer, k);
    const besitzer: Besitzer = r.geparkt ? { geparktId: r.id } : { anfrageId: r.id };
    await speichereAnhaenge(env, einst, anhaenge, besitzer, korrelation);
    await merke(env.DB, mail.messageId, besitzer);
  } catch (e) {
    // Dublette (gleiche FIN oder gleiches Kennzeichen im Fenster): die Mail ergänzt die vorhandene Anfrage.
    if (e instanceof AppFehler && e.code === "DUBLETTE" && typeof e.kontext?.["vorhandeneAnfrage"] === "string") {
      const id = e.kontext["vorhandeneAnfrage"];
      await haengeAn(u, id, { text: text || betreff || absender }, k);
      await speichereAnhaenge(env, einst, anhaenge, { anfrageId: id }, korrelation);
      await merke(env.DB, mail.messageId, { anfrageId: id });
      return;
    }
    throw e;
  }
}

/**
 * Ergänzt die regelbasierte Auslese um KI-Felder aus Text und Bildanhängen. Übernommen wird nur ein
 * Feld mit mindestens `ki.mindestSicherheit`, das das Schema besteht. Regelbasiert erkannte Felder
 * haben Vorrang; widersprechen sich zwei KI-Quellen, bleibt das Feld offen (Rückfrage statt Raten).
 * Ohne KI oder ohne Treffer kommt die regelbasierte Auslese unverändert zurück.
 */
async function ergaenzeDurchKi(env: Bindings, einst: Einstellungen, regel: MailAuslese, text: string, anhaenge: Attachment[], anfrageId: string | null, korrelation: string, abh: KiAbhaengigkeiten): Promise<MailAuslese> {
  const ki = await kiFuer(env, einst, { korrelationsId: korrelation, ...(anfrageId ? { anfrageId } : {}) }, abh);
  // Fehlt nichts Wesentliches, kostet eine KI-Anfrage nur Geld: die Regeln haben schon alles.
  const pflicht = ["marke", "modell", ...(await einst.lese("antwort.pflichtangaben"))] as Array<keyof Fahrzeug>;
  if (pflicht.every((f) => regel.fahrzeug[f] !== undefined)) return regel;
  const frei = ki.kann("freitext_auslesen") && text !== "";
  const foto = ki.kann("dokument_auslesen");
  if (!frei && !foto) return regel;

  const ergebnisse: AuslesenErgebnis[] = [];
  if (frei) {
    const r = await ki.freitextAuslesen(text);
    if (r) ergebnisse.push(r);
  }
  if (foto) {
    const maxAnzahl = await einst.lese("mail.anhangMaxAnzahl");
    const maxBytes = await einst.lese("mail.anhangMaxBytes");
    const erlaubt = (await einst.lese("mail.anhangTypen")).map((t) => t.toLowerCase());
    for (const a of anhaenge.slice(0, maxAnzahl)) {
      const typ = (a.mimeType ?? "").toLowerCase().split(";")[0]!.trim();
      if (!typ.startsWith("image/") || !erlaubt.includes(typ)) continue;
      const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
      if (bytes.byteLength > maxBytes) continue;
      const r = await ki.dokumentAuslesen({ mime: typ, daten: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
      if (r) ergebnisse.push(r);
    }
  }
  if (ergebnisse.length === 0) return regel;

  const mindest = await einst.lese("ki.mindestSicherheit");
  const kandidaten = new Map<keyof Fahrzeug, unknown[]>();
  for (const r of ergebnisse) {
    for (const [feld, wert] of Object.entries(r.fahrzeug) as Array<[keyof Fahrzeug, unknown]>) {
      if (wert === undefined || feld in regel.fahrzeug) continue;
      if ((r.sicherheit[feld] ?? 0) < mindest) continue;
      const teil = FahrzeugSchema.shape[feld].safeParse(wert);
      if (!teil.success) continue;
      kandidaten.set(feld, [...(kandidaten.get(feld) ?? []), teil.data]);
    }
  }
  const fahrzeug: Partial<Fahrzeug> = { ...regel.fahrzeug };
  for (const [feld, werte] of kandidaten) {
    if (new Set(werte.map((w) => JSON.stringify(w))).size === 1) (fahrzeug as Record<string, unknown>)[feld] = werte[0];
  }
  return { ...regel, fahrzeug, klar: fahrzeug.marke !== undefined && fahrzeug.modell !== undefined };
}

/** Fragt den KI-Anschluss, falls er die Fähigkeit hat; jeder Fehlschlag ist null und wurde vom Adapter schon mit Fehlercode gemeldet. */
async function ordneEin(env: Bindings, einst: Einstellungen, betreff: string, text: string, anfrageId: string | null, korrelation: string, abh: KiAbhaengigkeiten): Promise<Einordnung | null> {
  const ki = await kiFuer(env, einst, { korrelationsId: korrelation, ...(anfrageId ? { anfrageId } : {}) }, abh);
  if (!ki.kann("anfrage_einordnen")) return null;
  return ki.anfrageEinordnen([betreff, text].filter(Boolean).join("\n\n"));
}

/** Parkt die Mail ohne jede Antwort: ein Mensch entscheidet. Kein Preis, keine Zusage, kein Versand. */
async function parkeFuerMensch(env: Bindings, einst: Einstellungen, e: Omit<UnklarEingabe, "bezug">, grund: string): Promise<void> {
  const id = crypto.randomUUID();
  const nutzlast = { name: e.name, betreff: e.betreff, text: e.text, messageId: e.mail.messageId ?? null };
  await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES (?1, ?2, 'email', ?3, ?4, ?5)")
    .bind(id, e.kontakt, JSON.stringify(nutzlast), grund, e.korrelation)
    .run();
  await speichereAnhaenge(env, einst, e.anhaenge, { geparktId: id }, e.korrelation);
  await merke(env.DB, e.mail.messageId, { geparktId: id });
}

interface UnklarEingabe {
  kontakt: string;
  name: string;
  betreff: string;
  text: string;
  anhaenge: Attachment[];
  mail: Email;
  bezug: MailBezug;
  korrelation: string;
}

/** Marke/Modell nicht sicher erkannt: Mail parken (Mensch sieht sie) und, unter dem Flutschutz, einmal nachfragen. */
async function parkeUnklar(env: Bindings, einst: Einstellungen, u: AnfrageUmgebung, e: UnklarEingabe): Promise<void> {
  const max = await einst.lese("eingang.maxJeAbsenderUndTag");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM eingang_geparkt WHERE lower(kontakt) = ?1 AND erstellt_am >= ?2")
    .bind(e.kontakt, new Date(Date.now() - TAG_MS).toISOString())
    .first<{ n: number }>();
  const ueberLimit = (n?.n ?? 0) >= max;

  const id = crypto.randomUUID();
  const nutzlast = { name: e.name, betreff: e.betreff, text: e.text, messageId: e.mail.messageId ?? null };
  await env.DB.prepare("INSERT INTO eingang_geparkt (id, kontakt, kanal, nutzlast, grund, korrelation) VALUES (?1, ?2, 'email', ?3, 'mail_unklar', ?4)")
    .bind(id, e.kontakt, JSON.stringify(nutzlast), e.korrelation)
    .run();
  await speichereAnhaenge(env, einst, e.anhaenge, { geparktId: id }, e.korrelation);
  await merke(env.DB, e.mail.messageId, { geparktId: id });

  if (ueberLimit) {
    await fehlerSpeichern(env.DB, { fehler: new AppFehler("ZU_VIELE_ANFRAGEN", "Mails eines Absenders über dem Tageslimit, keine Rückfrage"), ort: "email:eingang", korrelationsId: e.korrelation }, "info", env.EMAIL);
    return;
  }
  const kanal = await u.kanalFuer!(e.kontakt);
  if (!kanal) return;
  try {
    await sende(env.DB, einst, {
      kanal,
      an: e.kontakt,
      anlass: "rueckfrage",
      werte: { name: e.name, fahrzeug: "", fehlend: "marke, modell" },
      korrelation: e.korrelation,
      schluessel: `rueckfrage-mail:${id}`,
    });
  } catch (fehler) {
    // Not-Aus „aus“ parkt die Rückfrage; alles andere ist ein Fehler für den Alarm.
    if (!(fehler instanceof AppFehler && fehler.code === "AUTOPILOT_GESPERRT")) throw fehler;
  }
}
