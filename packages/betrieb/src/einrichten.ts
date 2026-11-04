/**
 * Legt die Cloudflare-Ressourcen (D1, Queues inkl. Dead-Letter, R2) je Umgebung an,
 * die `apps/api/wrangler.jsonc` verlangt. Idempotent: vorher `list`, nur Fehlendes wird
 * angelegt. Schreibt nie in die Konfiguration; die D1-ID wird nur ausgegeben.
 * wrangler wird über eine einschleusbare Ausführfunktion gerufen (Tests: Attrappe).
 */

export interface WranglerErgebnis {
  code: number;
  stdout: string;
  stderr: string;
}
export type Ausfuehren = (args: string[]) => Promise<WranglerErgebnis>;

export class EinrichtenFehler extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EinrichtenFehler";
  }
}

export interface Umgebung {
  name: string;
  /** Wert für `--env`; undefiniert = oberste Ebene (Produktion). */
  env: string | undefined;
  d1: string[];
  queues: string[];
  r2: string[];
}

export interface UmgebungsErgebnis {
  umgebung: string;
  angelegt: string[];
  vorhanden: string[];
  d1Ids: Record<string, string>;
}

/** wrangler.jsonc: Kommentare und Komma vor `}`/`]` entfernen, Strings bleiben unberührt. */
export function parseJsonc(text: string): unknown {
  let aus = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      aus += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const ende = text.indexOf("*/", i + 2);
      i = ende < 0 ? text.length : ende + 2;
    } else {
      aus += c;
      i++;
    }
  }
  return JSON.parse(aus.replace(/,(\s*[}\]])/g, "$1"));
}

type Abschnitt = Record<string, unknown>;

function alsListe(wert: unknown): Abschnitt[] {
  return Array.isArray(wert) ? (wert as Abschnitt[]) : [];
}

function umgebungAus(name: string, env: string | undefined, a: Abschnitt): Umgebung {
  const queues = new Set<string>();
  const q = (a.queues ?? {}) as Abschnitt;
  for (const p of alsListe(q.producers)) if (typeof p.queue === "string") queues.add(p.queue);
  for (const c of alsListe(q.consumers)) {
    if (typeof c.queue === "string") queues.add(c.queue);
    if (typeof c.dead_letter_queue === "string") queues.add(c.dead_letter_queue);
  }
  const namen = (liste: unknown, feld: string) =>
    alsListe(liste)
      .map((e) => e[feld])
      .filter((x): x is string => typeof x === "string");
  return {
    name,
    env,
    d1: namen(a.d1_databases, "database_name"),
    queues: [...queues],
    r2: namen(a.r2_buckets, "bucket_name"),
  };
}

export function leseUmgebungen(konfigText: string): Umgebung[] {
  let konfig: Abschnitt;
  try {
    konfig = parseJsonc(konfigText) as Abschnitt;
  } catch (e) {
    throw new EinrichtenFehler(`wrangler.jsonc nicht lesbar: ${(e as Error).message}`);
  }
  const ergebnis = [umgebungAus("produktion", undefined, konfig)];
  const envs = (konfig.env ?? {}) as Record<string, Abschnitt>;
  for (const [name, a] of Object.entries(envs)) ergebnis.push(umgebungAus(name, name, a));
  return ergebnis;
}

/** Ganzes Wort im Ausgabetext (Namen enthalten `-`, daher kein \b). */
function enthaelt(ausgabe: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, "m").test(ausgabe);
}

async function rufe(ausfuehren: Ausfuehren, args: string[]): Promise<string> {
  const r = await ausfuehren(args);
  if (r.code !== 0) {
    const grund = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ");
    throw new EinrichtenFehler(`wrangler ${args.join(" ")} endete mit Code ${r.code}: ${grund}`);
  }
  return r.stdout;
}

function d1Liste(ausgabe: string): Record<string, string> {
  let roh: unknown;
  try {
    roh = JSON.parse(ausgabe);
  } catch {
    throw new EinrichtenFehler("wrangler d1 list --json lieferte kein JSON");
  }
  const ids: Record<string, string> = {};
  for (const e of alsListe(roh)) {
    if (typeof e.name === "string" && typeof e.uuid === "string") ids[e.name] = e.uuid;
  }
  return ids;
}

export async function richteUmgebungEin(u: Umgebung, ausfuehren: Ausfuehren): Promise<UmgebungsErgebnis> {
  const erg: UmgebungsErgebnis = { umgebung: u.name, angelegt: [], vorhanden: [], d1Ids: {} };

  if (u.d1.length > 0) {
    let ids = d1Liste(await rufe(ausfuehren, ["d1", "list", "--json"]));
    for (const name of u.d1) {
      if (ids[name]) {
        erg.vorhanden.push(`d1:${name}`);
        continue;
      }
      await rufe(ausfuehren, ["d1", "create", name]);
      erg.angelegt.push(`d1:${name}`);
      ids = d1Liste(await rufe(ausfuehren, ["d1", "list", "--json"]));
    }
    for (const name of u.d1) {
      const id = ids[name];
      if (!id) throw new EinrichtenFehler(`D1 ${name} nach dem Anlegen nicht in der Liste`);
      erg.d1Ids[name] = id;
    }
  }

  if (u.queues.length > 0) {
    const liste = await rufe(ausfuehren, ["queues", "list"]);
    for (const name of u.queues) {
      if (enthaelt(liste, name)) {
        erg.vorhanden.push(`queue:${name}`);
      } else {
        await rufe(ausfuehren, ["queues", "create", name]);
        erg.angelegt.push(`queue:${name}`);
      }
    }
  }

  if (u.r2.length > 0) {
    const liste = await rufe(ausfuehren, ["r2", "bucket", "list"]);
    for (const name of u.r2) {
      if (enthaelt(liste, name)) {
        erg.vorhanden.push(`r2:${name}`);
      } else {
        await rufe(ausfuehren, ["r2", "bucket", "create", name]);
        erg.angelegt.push(`r2:${name}`);
      }
    }
  }
  return erg;
}

export async function einrichten(
  konfigText: string,
  ausfuehren: Ausfuehren,
  ausgabe: (zeile: string) => void,
): Promise<UmgebungsErgebnis[]> {
  const ergebnisse: UmgebungsErgebnis[] = [];
  for (const u of leseUmgebungen(konfigText)) {
    ausgabe(`== ${u.name}`);
    const e = await richteUmgebungEin(u, ausfuehren);
    for (const x of e.vorhanden) ausgabe(`  vorhanden  ${x}`);
    for (const x of e.angelegt) ausgabe(`  angelegt   ${x}`);
    for (const [name, id] of Object.entries(e.d1Ids)) {
      ausgabe(`  Eintragen in wrangler.jsonc (${u.name}): database_name "${name}" -> database_id "${id}"`);
    }
    ergebnisse.push(e);
  }
  return ergebnisse;
}
