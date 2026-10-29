import { EINSTELLUNGEN, type EinstellungsSchluessel, type EinstellungsWert, type Fahrzeug } from "@kfz/shared";
import { AppFehler } from "../fehler/app-fehler.js";
import type { Vergleichsinserat } from "../quelle/port.js";
import { bewerte, ladeBewertungsEinstellungen, type Bewertung } from "./bewerten.js";

/** Was die Vorschau je Bericht braucht; das HTML wird bewusst nicht geladen. */
export interface VorschauBericht {
  anfrageId: string;
  generation: number;
  fahrzeug: Fahrzeug;
  vergleiche: Bewertung["vergleiche"];
}

type Leser = { lese<K extends EinstellungsSchluessel>(k: K): Promise<EinstellungsWert<K>> };

export interface VorschauZahlen {
  marktpreisEuro: number | null;
  verkaufspreisEuro: number | null;
  ankaufspreisEuro: number | null;
  konfidenz: number;
  anzahlVergleiche: number;
  anMenschGruende: string[];
}

export interface VorschauZeile {
  anfrageId: string;
  generation: number;
  vorher: VorschauZahlen;
  nachher: VorschauZahlen;
  /** Unterschied Ankaufspreis (nachher − vorher); null, wenn einer der beiden Preise fehlt. */
  ankaufDifferenzEuro: number | null;
  geaendert: boolean;
}

function zahlen(b: Bewertung): VorschauZahlen {
  return {
    marktpreisEuro: b.marktpreisEuro,
    verkaufspreisEuro: b.verkaufspreisEuro,
    ankaufspreisEuro: b.ankaufspreisEuro,
    konfidenz: b.konfidenz,
    anzahlVergleiche: b.anzahlVergleiche,
    anMenschGruende: b.anMensch?.gruende.map((g) => g.code) ?? [],
  };
}

/** Die im Bericht gespeicherten (bereits bereinigten) Vergleiche als Quelle: kein Abruf bei mobile.de. */
function ausBericht(b: VorschauBericht): { suche(): Promise<Vergleichsinserat[]> } {
  const inserate: Vergleichsinserat[] = b.vergleiche.map((v) => ({
    id: v.id,
    titel: "",
    preisBruttoEuro: v.preisEuro,
    ...(v.kilometer !== undefined ? { kilometer: v.kilometer } : {}),
    ...(v.erstzulassung !== undefined ? { erstzulassung: v.erstzulassung } : {}),
    anbieter: "haendler" as const,
  }));
  return { suche: async () => inserate };
}

/** Prüft den Wert gegen das Schema der Einstellung; `null` = Standardwert. */
export function pruefeVorschauWert(k: EinstellungsSchluessel, wert: unknown): unknown {
  if (wert === null) return EINSTELLUNGEN[k].standard;
  const p = EINSTELLUNGEN[k].schema.safeParse(wert);
  if (!p.success) throw new AppFehler("EINGABE_UNGUELTIG", `Ungültiger Wert für ${k}`, { details: p.error.issues });
  return p.data;
}

/**
 * Rechnet die Berichte einmal mit den aktuellen Einstellungen und einmal mit dem neuen Wert
 * neu (nichts wird gespeichert, keine Datenquelle gerufen). Beide Läufe nutzen dieselben
 * gespeicherten Vergleiche; der Unterschied stammt damit allein aus der Änderung.
 */
export async function rechneVorschau(
  einstellungen: Leser,
  schluessel: EinstellungsSchluessel,
  neuerWert: unknown,
  berichte: VorschauBericht[],
  heute: Date,
): Promise<VorschauZeile[]> {
  const aktuell = await ladeBewertungsEinstellungen(einstellungen);
  const geaendert = await ladeBewertungsEinstellungen({
    lese: async <K extends EinstellungsSchluessel>(k: K) => (k === schluessel ? (neuerWert as EinstellungsWert<K>) : einstellungen.lese(k)),
  });
  const zeilen: VorschauZeile[] = [];
  for (const b of berichte) {
    const fahrzeug: Fahrzeug = b.fahrzeug;
    const suche = ausBericht(b);
    const [v, n] = await Promise.all([
      bewerte({ fahrzeug, suche, einstellungen: aktuell, heute }),
      bewerte({ fahrzeug, suche, einstellungen: geaendert, heute }),
    ]);
    const vorher = zahlen(v);
    const nachher = zahlen(n);
    zeilen.push({
      anfrageId: b.anfrageId,
      generation: b.generation,
      vorher,
      nachher,
      ankaufDifferenzEuro: vorher.ankaufspreisEuro !== null && nachher.ankaufspreisEuro !== null ? nachher.ankaufspreisEuro - vorher.ankaufspreisEuro : null,
      geaendert: JSON.stringify(vorher) !== JSON.stringify(nachher),
    });
  }
  return zeilen;
}

/** Die neuesten `anzahl` Berichte (einer je Anfrage und Generation); beschädigte Zeilen werden übersprungen. */
export async function ladeLetzteBerichte(db: D1Database, anzahl: number): Promise<VorschauBericht[]> {
  if (anzahl <= 0) return [];
  const { results } = await db
    .prepare("SELECT anfrage_id, generation, eingabe, vergleiche FROM berichte ORDER BY erstellt_am DESC, id DESC LIMIT ?1")
    .bind(anzahl)
    .all<{ anfrage_id: string; generation: number; eingabe: string; vergleiche: string }>();
  const r: VorschauBericht[] = [];
  for (const z of results) {
    try {
      r.push({
        anfrageId: z.anfrage_id,
        generation: z.generation,
        fahrzeug: (JSON.parse(z.eingabe) as { fahrzeug: Fahrzeug }).fahrzeug,
        vergleiche: JSON.parse(z.vergleiche),
      });
    } catch {
      // Beschädigter Bericht: für die Vorschau unbrauchbar, kein Grund abzubrechen.
    }
  }
  return r;
}
