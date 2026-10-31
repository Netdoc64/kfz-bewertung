import type { MiddlewareHandler } from "hono";
import type { AppUmgebung, Bindings, Variablen } from "../env.js";
import type { Einstellungen } from "../einstellungen/dienst.js";
import { AppFehler } from "../fehler/app-fehler.js";

/** Umgebung der App-Routen: zusätzlich zur Admin-Umgebung die Kennung des gekoppelten Geräts. */
export type GeraeteUmgebung = { Bindings: Bindings; Variables: Variablen & { geraet: string } };

const jetzt = () => new Date().toISOString();

async function hash(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function zufallHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// 32 Zeichen ohne verwechselbare (0/O, 1/I): 256 % 32 = 0, also ohne Verzerrung abbildbar.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LAENGE = 12;

function zufallCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(CODE_LAENGE));
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

const normalisiere = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

/** Erzeugt einen einmaligen Kopplungscode; in D1 liegt nur der Hash. */
export async function erzeugeKopplungscode(db: D1Database, einstellungen: Einstellungen, erstelltVon: string) {
  const minuten = await einstellungen.lese("app.kopplungscodeGueltigMinuten");
  const code = zufallCode();
  const ablaufAm = new Date(Date.now() + minuten * 60_000).toISOString();
  await db.prepare("INSERT INTO kopplungscodes (code_hash, erstellt_von, ablauf_am) VALUES (?1, ?2, ?3)").bind(await hash(code), erstelltVon, ablaufAm).run();
  return { code, ablaufAm };
}

/** Tauscht einen Kopplungscode einmalig gegen ein Geräte-Token. Das Token wird nur hier im Klartext ausgegeben. */
export async function koppeln(db: D1Database, einstellungen: Einstellungen, code: string, name: string) {
  const tage = await einstellungen.lese("app.tokenLaufzeitTage");
  const jetztIso = jetzt();
  // Einlösen und Prüfen in einer Anweisung: zwei gleichzeitige Versuche lösen den Code nur einmal ein.
  const r = await db
    .prepare("UPDATE kopplungscodes SET eingeloest_am = ?2 WHERE code_hash = ?1 AND eingeloest_am IS NULL AND ablauf_am > ?2")
    .bind(await hash(normalisiere(code)), jetztIso)
    .run();
  if (r.meta.changes === 0) throw new AppFehler("KOPPLUNGSCODE_UNGUELTIG");
  const id = crypto.randomUUID();
  const token = zufallHex(32);
  const ablaufAm = new Date(Date.now() + tage * 86_400_000).toISOString();
  await db
    .prepare("INSERT INTO geraete (id, name, token_hash, erstellt_am, ablauf_am) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, name, await hash(token), jetztIso, ablaufAm)
    .run();
  return { geraetId: id, token, ablaufAm };
}

export interface GeraeteZeile {
  id: string;
  name: string;
  erstellt_am: string;
  ablauf_am: string;
  widerrufen_am: string | null;
}

export async function listeGeraete(db: D1Database): Promise<GeraeteZeile[]> {
  const { results } = await db.prepare("SELECT id, name, erstellt_am, ablauf_am, widerrufen_am FROM geraete ORDER BY erstellt_am DESC, id LIMIT 200").all<GeraeteZeile>();
  return results;
}

/** Widerruf ist idempotent: ein bereits widerrufenes Gerät behält seinen ersten Zeitpunkt. */
export async function widerrufe(db: D1Database, id: string): Promise<void> {
  const r = await db.prepare("UPDATE geraete SET widerrufen_am = COALESCE(widerrufen_am, ?2) WHERE id = ?1").bind(id, jetzt()).run();
  if (r.meta.changes === 0) throw new AppFehler("NICHT_GEFUNDEN");
}

/** App-Bereich: Authorization: Bearer <Geräte-Token>, per Hash geprüft, mit Ablauf und Widerruf. */
export const geraetePflicht: MiddlewareHandler<GeraeteUmgebung> = async (c, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!m?.[1]) throw new AppFehler("NICHT_ANGEMELDET");
  const z = await c.env.DB.prepare("SELECT id, ablauf_am, widerrufen_am FROM geraete WHERE token_hash = ?1")
    .bind(await hash(m[1]))
    .first<{ id: string; ablauf_am: string; widerrufen_am: string | null }>();
  if (!z) throw new AppFehler("NICHT_ANGEMELDET");
  if (z.widerrufen_am) throw new AppFehler("GERAET_WIDERRUFEN");
  if (z.ablauf_am <= jetzt()) throw new AppFehler("NICHT_ANGEMELDET", "Geräte-Token abgelaufen");
  c.set("geraet", z.id);
  // Bestehender Fachcode liest die Handelnden aus „admin"; für Geräte ist das die Gerätekennung.
  c.set("admin", `geraet:${z.id}`);
  return next();
};

export type { AppUmgebung };
