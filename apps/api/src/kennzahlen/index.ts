import { STATUS, type Status } from "@kfz/shared";

/** Eine Zeile aus `anfrage_ereignisse`, ergänzt um den Zeitpunkt des nächsten Ereignisses derselben Anfrage. */
export interface EreignisZeile {
  anfrage_id: string;
  aktion: string;
  status_von: string | null;
  status_nach: string;
  durch: string;
  notiz: string | null;
  am: string;
  naechste: string | null;
}

export interface Zeitraum {
  von: string;
  bis: string;
}

export interface Dauer {
  anzahl: number;
  /** Sekunden */
  mittel: number | null;
  median: number | null;
  max: number | null;
}

export interface KonfidenzKlasse {
  /** Untere Grenze (einschließlich), `null` = nach unten offen. */
  von: number | null;
  /** Obere Grenze (ausschließlich), `null` = nach oben offen. */
  bis: number | null;
  anzahl: number;
}

export interface Kennzahlen {
  zeitraum: Zeitraum;
  anfragen: number;
  durchlaufzeit: Partial<Record<Status, Dauer>> & { offen: number };
  anMensch: { anzahl: number; anteil: number | null; mitGrund: number; anteilMitGrund: number | null; gruende: Record<string, number> };
  konfidenz: { berichte: number; mittel: number | null; klassen: KonfidenzKlasse[] };
  fehlerrate: { bewertungen: number; fehlgeschlagen: number; rate: number | null };
  freigabedauer: Dauer;
}

const ms = (t: string) => Date.parse(t);
const runde = (x: number) => Math.round(x * 1e6) / 1e6;

export function dauer(sekunden: number[]): Dauer {
  if (sekunden.length === 0) return { anzahl: 0, mittel: null, median: null, max: null };
  const s = [...sekunden].sort((a, b) => a - b);
  const mitte = s.length >> 1;
  const median = s.length % 2 ? s[mitte]! : (s[mitte - 1]! + s[mitte]!) / 2;
  return { anzahl: s.length, mittel: runde(s.reduce((a, b) => a + b, 0) / s.length), median: runde(median), max: s[s.length - 1]! };
}

const verhaeltnis = (z: number, n: number) => (n === 0 ? null : runde(z / n));

export function konfidenzKlassen(werte: number[], grenzen: number[]): KonfidenzKlasse[] {
  const g = [...grenzen].sort((a, b) => a - b);
  const klassen: KonfidenzKlasse[] = [null, ...g].map((von, i) => ({ von, bis: g[i] ?? null, anzahl: 0 }));
  for (const w of werte) klassen[g.filter((x) => w >= x).length]!.anzahl++;
  return klassen;
}

/**
 * Rechnet die Kennzahlen aus Ereignissen (im Zeitraum begonnen) und Konfidenzwerten der Berichte.
 * Verweildauer: Zeit von einem Statuswechsel bis zum nächsten Ereignis derselben Anfrage;
 * ohne Folgeereignis ist die Anfrage noch dort und zählt unter `offen`.
 */
export function berechne(zeitraum: Zeitraum, ereignisse: EreignisZeile[], konfidenzen: number[], grenzen: number[]): Kennzahlen {
  const verweil = new Map<string, number[]>();
  let offen = 0;
  const freigabe: number[] = [];
  const anfragen = new Set<string>();
  const anMensch = new Set<string>();
  const mitGrund = new Set<string>();
  const gruende: Record<string, number> = {};
  let bewertungen = 0;
  let fehlgeschlagen = 0;

  for (const e of ereignisse) {
    anfragen.add(e.anfrage_id);
    if (e.naechste === null) offen++;
    else {
      const sek = (ms(e.naechste) - ms(e.am)) / 1000;
      (verweil.get(e.status_nach) ?? verweil.set(e.status_nach, []).get(e.status_nach)!).push(sek);
      if (e.status_nach === "zur_freigabe") freigabe.push(sek);
    }
    if (e.status_von === "in_bewertung") {
      bewertungen++;
      if (e.aktion === "fehlschlag") fehlgeschlagen++;
    }
    if (e.status_nach === "an_mensch" && !anMensch.has(e.anfrage_id)) {
      anMensch.add(e.anfrage_id);
      const grund = e.notiz?.trim();
      if (grund) {
        mitGrund.add(e.anfrage_id);
        // Systemgründe sind Codes, durch Komma getrennt; Freitext eines Admins zählt als ein Grund.
        for (const g of e.durch === "system" ? grund.split(",").map((x) => x.trim()).filter(Boolean) : [grund]) gruende[g] = (gruende[g] ?? 0) + 1;
      }
    }
  }

  const durchlaufzeit: Kennzahlen["durchlaufzeit"] = { offen };
  for (const s of STATUS) {
    const w = verweil.get(s);
    if (w) durchlaufzeit[s] = dauer(w);
  }
  return {
    zeitraum,
    anfragen: anfragen.size,
    durchlaufzeit,
    anMensch: {
      anzahl: anMensch.size,
      anteil: verhaeltnis(anMensch.size, anfragen.size),
      mitGrund: mitGrund.size,
      anteilMitGrund: verhaeltnis(mitGrund.size, anMensch.size),
      gruende,
    },
    konfidenz: {
      berichte: konfidenzen.length,
      mittel: konfidenzen.length ? runde(konfidenzen.reduce((a, b) => a + b, 0) / konfidenzen.length) : null,
      klassen: konfidenzKlassen(konfidenzen, grenzen),
    },
    fehlerrate: { bewertungen, fehlgeschlagen, rate: verhaeltnis(fehlgeschlagen, bewertungen) },
    freigabedauer: dauer(freigabe),
  };
}

export async function ladeKennzahlen(db: D1Database, zeitraum: Zeitraum, grenzen: number[]): Promise<Kennzahlen> {
  const [ereignisse, berichte] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM (
           SELECT anfrage_id, aktion, status_von, status_nach, durch, notiz, am,
                  LEAD(am) OVER (PARTITION BY anfrage_id ORDER BY id) AS naechste
           FROM anfrage_ereignisse
         ) WHERE am >= ?1 AND am < ?2 ORDER BY am`,
      )
      .bind(zeitraum.von, zeitraum.bis)
      .all<EreignisZeile>(),
    db
      .prepare("SELECT json_extract(zahlen, '$.konfidenz') AS konfidenz FROM berichte WHERE erstellt_am >= ?1 AND erstellt_am < ?2")
      .bind(zeitraum.von, zeitraum.bis)
      .all<{ konfidenz: number | null }>(),
  ]);
  const konfidenzen = berichte.results.map((b) => b.konfidenz).filter((k): k is number => typeof k === "number");
  return berechne(zeitraum, ereignisse.results, konfidenzen, grenzen);
}
