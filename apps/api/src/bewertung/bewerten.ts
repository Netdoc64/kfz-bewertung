import type { AnkaufRegel, EinstellungsSchluessel, EinstellungsWert, Fahrzeug, SuchStufe } from "@kfz/shared";
import type { Suche, Vergleichsinserat } from "../quelle/port.js";
import {
  alterInJahren,
  berechneKorrektur,
  filterInserate,
  iqrBereinigen,
  konfidenz,
  median,
  quantil,
  rundeCent,
  runde,
  sortiert,
  streuungProzent,
  vergleichsPreis,
  type Korrektur,
} from "./kern.js";
import { bewerteRegeln, type RegelErgebnis } from "./regeln.js";

/** Alle Einstellungen, die die Bewertung liest. Schlüssel = Registry-Schlüssel. */
const SCHLUESSEL = [
  "bewertung.mindestVergleiche",
  "bewertung.zielVergleiche",
  "bewertung.suchStufen",
  "bewertung.ausreisserIqrFaktor",
  "bewertung.mindestPreisEuro",
  "bewertung.ausschlussBegriffe",
  "bewertung.angebotsAbschlagProzent",
  "bewertung.kmKorrekturProzentJe10000",
  "bewertung.alterKorrekturProzentJeJahr",
  "bewertung.konfidenzStreuungGrenzeProzent",
  "bewertung.rundungEuro",
  "ankauf.margeProzent",
  "ankauf.aufbereitungPauschaleEuro",
  "ankauf.standkostenEuroJeTag",
  "ankauf.erwarteteStandtage",
  "ankauf.spanneProzent",
  "ankauf.maxGesamtAbschlagProzent",
  "ankauf.mindestPreisEuro",
  "ankauf.maxSpanneProzent",
  "ankauf.regeln",
  "ablauf.eskalation",
] as const satisfies readonly EinstellungsSchluessel[];

export type BewertungsEinstellungen = { [K in (typeof SCHLUESSEL)[number]]: EinstellungsWert<K> };

/** Liest die Bewertungseinstellungen aus dem Einstellungsdienst. */
export async function ladeBewertungsEinstellungen(e: {
  lese<K extends EinstellungsSchluessel>(k: K): Promise<EinstellungsWert<K>>;
}): Promise<BewertungsEinstellungen> {
  const werte = await Promise.all(SCHLUESSEL.map((k) => e.lese(k)));
  return Object.fromEntries(SCHLUESSEL.map((k, i) => [k, werte[i]])) as BewertungsEinstellungen;
}

export type AnMenschCode =
  | "zu_wenige_vergleiche"
  | "konfidenz_zu_niedrig"
  | "ankauf_ueber_maximum"
  | "ankauf_unter_minimum"
  | "ankauf_ueber_marktpreis"
  | "spanne_zu_gross"
  | "fahrzeugklasse_ausgeschlossen"
  | "ki_sonstiges";

export interface AnMenschGrund {
  code: AnMenschCode;
  /** Maßgebliche Zahlen/Werte zum Grund (Ist und Grenze). */
  werte: Record<string, number | string>;
}

export interface BewertungEingabe {
  fahrzeug: Fahrzeug;
  suche: Suche;
  einstellungen: BewertungsEinstellungen;
  heute: Date;
  /** Fahrzeugklasse aus der Einordnung (z. B. "oldtimer"); gegen `ausgeschlosseneKlassen` geprüft. */
  klasse?: string;
  /** Einordnung der KI ("sonstiges" → Mensch, wenn so eingestellt). Die KI liefert nie einen Preis. */
  kiEinordnung?: string;
}

export interface StufenVersuch {
  stufe: number;
  treffer: number;
  zuGuenstig: number;
  ausschlussBegriff: number;
  dubletten: number;
  ausreisser: number;
  bereinigt: number;
}

export interface Vergleich {
  id: string;
  preisEuro: number;
  kilometer?: number;
  erstzulassung?: string;
}

export interface Bewertung {
  /** Index der verwendeten Suchstufe (0-basiert); null ohne Treffer. */
  stufe: number | null;
  suchStufe: SuchStufe | null;
  versuche: StufenVersuch[];
  vergleiche: Vergleich[];
  anzahlVergleiche: number;
  preisStatistik: {
    medianEuro: number;
    q1Euro: number;
    q3Euro: number;
    minEuro: number;
    maxEuro: number;
    streuungProzent: number;
  } | null;
  korrektur: Korrektur | null;
  /** Marktpreis, Verkaufs- und Ankaufspreis sind auf `bewertung.rundungEuro` gerundet; null ohne Vergleiche. */
  marktpreisEuro: number | null;
  verkaufspreisEuro: number | null;
  abzuege: {
    margeEuro: number;
    aufbereitungEuro: number;
    standkostenEuro: number;
    regelnEuro: number;
  } | null;
  regeln: RegelErgebnis | null;
  ankaufspreisEuro: number | null;
  spanne: { vonEuro: number; bisEuro: number } | null;
  /** 0–1. */
  konfidenz: number;
  anMensch: { gruende: AnMenschGrund[] } | null;
}

function ohneLuecken<T>(w: (T | undefined)[]): T[] {
  return w.filter((x): x is T => x !== undefined);
}

function klassenGruende(e: BewertungEingabe): AnMenschGrund[] {
  const esk = e.einstellungen["ablauf.eskalation"];
  const r: AnMenschGrund[] = [];
  if (e.klasse && esk.ausgeschlosseneKlassen.includes(e.klasse)) {
    r.push({ code: "fahrzeugklasse_ausgeschlossen", werte: { klasse: e.klasse } });
  }
  if (esk.sonstigesAnMensch && e.kiEinordnung === "sonstiges") {
    r.push({ code: "ki_sonstiges", werte: { einordnung: "sonstiges" } });
  }
  return r;
}

export async function bewerte(eingabe: BewertungEingabe): Promise<Bewertung> {
  const { fahrzeug, suche, einstellungen: s, heute } = eingabe;

  // 1.–2. Suchstufen erweitern, filtern, per IQR bereinigen
  interface Stand {
    index: number;
    stufe: SuchStufe;
    bereinigt: Vergleichsinserat[];
  }
  const versuche: StufenVersuch[] = [];
  let bester: Stand | undefined;
  for (const [index, stufe] of s["bewertung.suchStufen"].entries()) {
    const roh = await suche.suche(fahrzeug, stufe);
    const f = filterInserate(roh, {
      mindestPreisEuro: s["bewertung.mindestPreisEuro"],
      ausschlussBegriffe: s["bewertung.ausschlussBegriffe"],
    });
    const iqr = iqrBereinigen(f.behalten, vergleichsPreis, s["bewertung.ausreisserIqrFaktor"]);
    versuche.push({
      stufe: index,
      treffer: roh.length,
      zuGuenstig: f.zuGuenstig.length,
      ausschlussBegriff: f.ausschlussBegriff.length,
      dubletten: f.dubletten.length,
      ausreisser: iqr.verworfen.length,
      bereinigt: iqr.behalten.length,
    });
    if (!bester || iqr.behalten.length > bester.bereinigt.length) bester = { index, stufe, bereinigt: iqr.behalten };
    if (iqr.behalten.length >= s["bewertung.zielVergleiche"]) break;
  }

  const gruende: AnMenschGrund[] = [];
  const bereinigt = bester?.bereinigt ?? [];
  const anzahl = bereinigt.length;
  const schritt = s["bewertung.rundungEuro"];

  if (anzahl < s["bewertung.mindestVergleiche"]) {
    gruende.push({ code: "zu_wenige_vergleiche", werte: { anzahl, mindestens: s["bewertung.mindestVergleiche"] } });
  }
  if (!bester || anzahl === 0) {
    return {
      stufe: null,
      suchStufe: null,
      versuche,
      vergleiche: [],
      anzahlVergleiche: 0,
      preisStatistik: null,
      korrektur: null,
      marktpreisEuro: null,
      verkaufspreisEuro: null,
      abzuege: null,
      regeln: null,
      ankaufspreisEuro: null,
      spanne: null,
      konfidenz: 0,
      anMensch: { gruende: [...gruende, ...klassenGruende(eingabe)] },
    };
  }

  // 3. Marktpreis = Median, korrigiert um km/Alter-Abweichung zum Zielfahrzeug
  const preise = sortiert(bereinigt.map(vergleichsPreis));
  const medianPreis = median(preise) as number;
  const streuung = streuungProzent(preise);
  const korrektur = berechneKorrektur({
    zielKilometer: fahrzeug.kilometer,
    zielAlterJahre: fahrzeug.erstzulassung ? alterInJahren(fahrzeug.erstzulassung, heute) : undefined,
    vergleichKilometer: median(ohneLuecken(bereinigt.map((i) => i.kilometer))),
    vergleichAlterJahre: median(
      ohneLuecken(bereinigt.map((i) => (i.erstzulassung ? alterInJahren(i.erstzulassung, heute) : undefined))),
    ),
    kmKorrekturProzentJe10000: s["bewertung.kmKorrekturProzentJe10000"],
    alterKorrekturProzentJeJahr: s["bewertung.alterKorrekturProzentJeJahr"],
  });
  const marktpreis = medianPreis * (1 + korrektur.gesamtProzent / 100);

  // 4. Erwarteter Verkaufspreis
  const verkaufspreis = marktpreis * (1 - s["bewertung.angebotsAbschlagProzent"] / 100);

  // 5. Ankaufspreis = Verkauf − Marge − Aufbereitung − Standkosten − Regeln
  const regeln = bewerteRegeln({
    fahrzeug,
    regeln: s["ankauf.regeln"] as AnkaufRegel[],
    verkaufspreisEuro: verkaufspreis,
    maxGesamtAbschlagProzent: s["ankauf.maxGesamtAbschlagProzent"],
    heute,
  });
  const abzuege = {
    margeEuro: (verkaufspreis * s["ankauf.margeProzent"]) / 100,
    aufbereitungEuro: s["ankauf.aufbereitungPauschaleEuro"],
    standkostenEuro: s["ankauf.standkostenEuroJeTag"] * s["ankauf.erwarteteStandtage"],
    regelnEuro: regeln.gesamtAbschlagEuro,
  };
  const ankauf = runde(
    verkaufspreis - abzuege.margeEuro - abzuege.aufbereitungEuro - abzuege.standkostenEuro - abzuege.regelnEuro,
    schritt,
  );
  const spannenAnteil = s["ankauf.spanneProzent"] / 100;
  const spanne = {
    vonEuro: runde(ankauf * (1 - spannenAnteil), schritt),
    bisEuro: runde(ankauf * (1 + spannenAnteil), schritt),
  };
  const markt = runde(marktpreis, schritt);
  const verkauf = runde(verkaufspreis, schritt);
  const konf = konfidenz({
    anzahl,
    zielVergleiche: s["bewertung.zielVergleiche"],
    streuungProzent: streuung,
    streuungGrenzeProzent: s["bewertung.konfidenzStreuungGrenzeProzent"],
  });

  // 6. Plausibilität (A7) und Eskalation (A6)
  const esk = s["ablauf.eskalation"];
  if (ankauf > markt) gruende.push({ code: "ankauf_ueber_marktpreis", werte: { ankaufEuro: ankauf, marktpreisEuro: markt } });
  if (ankauf < s["ankauf.mindestPreisEuro"]) {
    gruende.push({ code: "ankauf_unter_minimum", werte: { ankaufEuro: ankauf, mindestensEuro: s["ankauf.mindestPreisEuro"] } });
  }
  const spannenProzent = verkauf > 0 ? rundeCent(((verkauf - ankauf) / verkauf) * 100) : 100;
  if (spannenProzent > s["ankauf.maxSpanneProzent"]) {
    gruende.push({ code: "spanne_zu_gross", werte: { spanneProzent: spannenProzent, hoechstensProzent: s["ankauf.maxSpanneProzent"] } });
  }
  if (konf < esk.konfidenzMin) {
    gruende.push({ code: "konfidenz_zu_niedrig", werte: { konfidenz: konf, mindestens: esk.konfidenzMin } });
  }
  if (ankauf > esk.maxAnkaufEuro) {
    gruende.push({ code: "ankauf_ueber_maximum", werte: { ankaufEuro: ankauf, hoechstensEuro: esk.maxAnkaufEuro } });
  }
  gruende.push(...klassenGruende(eingabe));

  return {
    stufe: bester.index,
    suchStufe: bester.stufe,
    versuche,
    vergleiche: bereinigt.map((i) => ({
      id: i.id,
      preisEuro: vergleichsPreis(i),
      ...(i.kilometer !== undefined ? { kilometer: i.kilometer } : {}),
      ...(i.erstzulassung ? { erstzulassung: i.erstzulassung } : {}),
    })),
    anzahlVergleiche: anzahl,
    preisStatistik: {
      medianEuro: rundeCent(medianPreis),
      q1Euro: rundeCent(quantil(preise, 0.25)),
      q3Euro: rundeCent(quantil(preise, 0.75)),
      minEuro: preise[0] as number,
      maxEuro: preise[preise.length - 1] as number,
      streuungProzent: rundeCent(streuung),
    },
    korrektur: {
      ...korrektur,
      kmProzent: rundeCent(korrektur.kmProzent),
      alterProzent: rundeCent(korrektur.alterProzent),
      gesamtProzent: rundeCent(korrektur.gesamtProzent),
    },
    marktpreisEuro: markt,
    verkaufspreisEuro: verkauf,
    abzuege: {
      margeEuro: rundeCent(abzuege.margeEuro),
      aufbereitungEuro: abzuege.aufbereitungEuro,
      standkostenEuro: abzuege.standkostenEuro,
      regelnEuro: abzuege.regelnEuro,
    },
    regeln,
    ankaufspreisEuro: ankauf,
    spanne,
    konfidenz: konf,
    anMensch: gruende.length > 0 ? { gruende } : null,
  };
}
