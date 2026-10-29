import { moeglicheAktionen, STATUS, type Fahrzeug, type Status } from "@kfz/shared";
import { z } from "zod";
import { berichtIstGueltig, berichtLaden, type GespeicherterBericht } from "../bericht/index.js";
import { AppFehler } from "../fehler/app-fehler.js";
import { sende } from "../versand/index.js";
import { lade, wechsle, type AnfrageKontext, type AnfrageUmgebung, type Zeile } from "./dienst.js";
import { kanalFuerKontakt } from "./kanal.js";

export const AktionSchema = z.object({
  aktion: z.string().min(1).max(60),
  /** Version, die der Admin gesehen hat (optimistische Sperre). */
  version: z.number().int().positive(),
  notiz: z.string().trim().max(1000).optional(),
});
export type AktionEingabe = z.infer<typeof AktionSchema>;

export const ListeSchema = z.object({
  status: z.enum(STATUS).optional(),
  seite: z.coerce.number().int().positive().default(1),
});

/** Aktionen, die dem Kunden ein Angebot mit Preis schicken. */
const SENDEN = ["angebot_senden", "gegenangebot_senden"];

const SPALTEN = "id, kanal, status, version, kunde_name, kunde_kontakt, sprache, fahrzeug, rueckfragen, generation, erstellt_am, geaendert_am";

interface ListenZeile extends Zeile {
  erstellt_am: string;
  geaendert_am: string;
}

const beschriftungen = (u: AnfrageUmgebung): Promise<Record<string, string>> => u.einstellungen.lese("ablauf.statusBeschriftungen");

function ansicht(z: ListenZeile, namen: Record<string, string>) {
  const { fahrzeug, ...rest } = z;
  return { ...rest, fahrzeug: JSON.parse(fahrzeug) as Fahrzeug, statusText: namen[z.status] ?? z.status };
}

export async function listeAnfragen(u: AnfrageUmgebung, q: z.infer<typeof ListeSchema>) {
  const proSeite = await u.einstellungen.lese("ablauf.listeSeitenGroesse");
  const bedingung = q.status ? "WHERE status = ?1" : "";
  const bind = q.status ? [q.status] : [];
  const gesamt = await u.db.prepare(`SELECT COUNT(*) AS n FROM anfragen ${bedingung}`).bind(...bind).first<{ n: number }>();
  const { results } = await u.db
    .prepare(`SELECT ${SPALTEN} FROM anfragen ${bedingung} ORDER BY geaendert_am DESC, id LIMIT ${proSeite} OFFSET ${(q.seite - 1) * proSeite}`)
    .bind(...bind)
    .all<ListenZeile>();
  const namen = await beschriftungen(u);
  return { eintraege: results.map((z) => ansicht(z, namen)), seite: q.seite, proSeite, gesamt: gesamt?.n ?? 0 };
}

export async function detailAnfrage(u: AnfrageUmgebung, id: string, r2?: R2Bucket) {
  const z = await lade(u.db, id);
  const namen = await beschriftungen(u);
  const [ereignisse, nachrichten, kundenNachrichten] = await Promise.all([
    u.db.prepare("SELECT id, aktion, status_von, status_nach, durch, notiz, am FROM anfrage_ereignisse WHERE anfrage_id = ?1 ORDER BY id").bind(id).all<{ status_nach: string }>(),
    u.db.prepare("SELECT id, kanal, anlass, sprache, inhalt, status, fehler_code, erstellt_am FROM nachrichten WHERE anfrage_id = ?1 ORDER BY erstellt_am, id").bind(id).all(),
    u.db.prepare("SELECT id, kanal, text, generation, erstellt_am FROM anfrage_nachrichten WHERE anfrage_id = ?1 ORDER BY id").bind(id).all(),
  ]);
  let bericht: GespeicherterBericht | null = null;
  try {
    bericht = await berichtLaden(u.db, id, r2);
  } catch (e) {
    if (!(e instanceof AppFehler && e.code === "BERICHT_FEHLT")) throw e;
  }
  return {
    anfrage: ansicht(z as ListenZeile, namen),
    ereignisse: ereignisse.results.map((e) => ({ ...e, statusNachText: namen[e.status_nach] ?? e.status_nach })),
    nachrichten: nachrichten.results,
    kundenNachrichten: kundenNachrichten.results,
    bericht,
    aktionen: moeglicheAktionen(z.status, "admin").map((a) => ({ name: a.name, nach: a.nach, nachText: namen[a.nach] ?? a.nach })),
  };
}

const euro = (w: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(w);

/** Schickt das Angebot aus dem gültigen Bericht. Wirft, wenn es nicht wirklich gesendet wurde. */
async function sendeAngebot(u: AnfrageUmgebung, z: Zeile, k: AnfrageKontext, r2?: R2Bucket): Promise<void> {
  const bericht = await berichtLaden(u.db, z.id, r2);
  if (!berichtIstGueltig(bericht, new Date())) throw new AppFehler("BERICHT_ABGELAUFEN", undefined, { kontext: { anfrageId: z.id } });
  const spanne = bericht.zahlen.spanne;
  if (!spanne) throw new AppFehler("BERICHT_FEHLT", "Der Bericht enthält keine Angebotsspanne", { kontext: { anfrageId: z.id } });

  const kontakt = z.kunde_kontakt ?? "";
  const kanal = u.kanalFuer ? await u.kanalFuer(kontakt) : u.email ? await kanalFuerKontakt(u.email, u.einstellungen, kontakt) : null;
  if (!kanal) throw new AppFehler("VERSAND_FEHLGESCHLAGEN", "Kein Kanal für dieses Angebot", { kontext: { anfrageId: z.id } });

  const f = JSON.parse(z.fahrzeug) as Fahrzeug;
  const r = await sende(u.db, u.einstellungen, {
    kanal,
    an: kontakt,
    anlass: "angebot",
    anfrageId: z.id,
    ...(z.sprache ? { sprache: z.sprache } : {}),
    werte: {
      name: z.kunde_name ?? "",
      fahrzeug: `${f.marke} ${f.modell}`,
      ankaufVon: euro(spanne.vonEuro),
      ankaufBis: euro(spanne.bisEuro),
      gueltigBis: new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(bericht.gueltigBis)),
    },
    korrelation: k.korrelation,
    schluessel: `angebot:${z.id}:${z.version}`,
  });
  // Geparkt (Autopilot „nur_verarbeiten“) heißt: nicht beim Kunden. Dann kein Statuswechsel.
  if (r.status !== "gesendet") throw new AppFehler("AUTOPILOT_GESPERRT", undefined, { kontext: { anlass: "angebot", nachrichtId: r.id } });
}

export async function fuehreAktionAus(
  u: AnfrageUmgebung,
  id: string,
  e: AktionEingabe,
  k: AnfrageKontext,
  r2?: R2Bucket,
): Promise<{ id: string; status: Status; statusText: string; version: number }> {
  const z = await lade(u.db, id);
  if (z.version !== e.version) throw new AppFehler("VERSION_KONFLIKT", undefined, { kontext: { anfrageId: id } });
  if (!moeglicheAktionen(z.status, "admin").some((a) => a.name === e.aktion)) {
    throw new AppFehler("STATUSWECHSEL_UNZULAESSIG", undefined, { kontext: { anfrageId: id, status: z.status, aktion: e.aktion } });
  }
  // Preis nur nach Freigabe: erst senden (der Versand-Port prüft die Freigabe), dann den Status setzen.
  if (SENDEN.includes(e.aktion)) await sendeAngebot(u, z, k, r2);
  await wechsle(u, z, e.aktion, "admin", k, e.notiz);
  const namen = await beschriftungen(u);
  return { id: z.id, status: z.status, statusText: namen[z.status] ?? z.status, version: z.version };
}
