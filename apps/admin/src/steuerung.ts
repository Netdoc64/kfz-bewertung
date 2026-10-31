import { plausibilitaetsWarnungen, type EinstellungsSchluessel } from "@kfz/shared";
import {
  ApiFehler,
  type Abweichungen,
  type Api,
  type Beschriftungen,
  type DeadLetterEintrag,
  type Detail,
  type EinstellungsEintrag,
  type FehlerEintrag,
  type Kennzahlen,
  type Liste,
  type Vorschau,
} from "./api.js";

export interface Meldung {
  art: "konflikt" | "fehler";
  code?: string;
  text: string;
  korrelationsId?: string;
}

/** Offene Bearbeitung einer Einstellung: der Text bleibt, wie getippt, bis gespeichert wird. */
export interface Bearbeitung {
  schluessel: string;
  text: string;
  warnungen: string[];
  /** Vorschau (A10) für genau diesen Text; ändert sich der Text, gilt sie nicht mehr. */
  vorschau: { text: string; ergebnis: Vorschau } | null;
}

export interface Zustand {
  ansicht: "liste" | "detail" | "einstellungen" | "fehler" | "deadletter" | "kennzahlen";
  laedt: boolean;
  beschriftungen: Beschriftungen;
  statusNamen: Record<string, string>;
  filter: string | null;
  seite: number;
  liste: Liste | null;
  detail: Detail | null;
  meldung: Meldung | null;
  einstellungen: EinstellungsEintrag[] | null;
  bearbeitung: Bearbeitung | null;
  fehlerListe: FehlerEintrag[] | null;
  deadLetter: DeadLetterEintrag[] | null;
  kennzahlen: Kennzahlen | null;
  abweichungen: Abweichungen | null;
  /** Gewählter Zeitraum als Datum (JJJJ-MM-TT); leer = Standardzeitraum der API. */
  zeitraum: { von: string; bis: string };
  /** App-Modus: nur Liste und Detail, keine Einstellungen, Fehler, Dead-Letter und Kennzahlen. */
  appModus: boolean;
}

export interface SteuerungOptionen {
  appModus?: boolean;
  /** Die API hat das Geräte-Token abgelehnt (401 / GERAET_WIDERRUFEN): Kopplung löschen, Kopplungsansicht zeigen. */
  beiWiderruf?: () => void;
}

/**
 * Zustand und Abläufe der Admin-Oberfläche, ohne DOM. Jede Änderung ruft `bei`
 * auf; die Ansicht zeichnet daraus neu.
 */
export class Steuerung {
  zustand: Zustand = {
    ansicht: "liste",
    laedt: false,
    beschriftungen: {},
    statusNamen: {},
    filter: null,
    seite: 1,
    liste: null,
    detail: null,
    meldung: null,
    einstellungen: null,
    bearbeitung: null,
    fehlerListe: null,
    deadLetter: null,
    kennzahlen: null,
    abweichungen: null,
    zeitraum: { von: "", bis: "" },
    appModus: false,
  };

  constructor(
    private readonly api: Api,
    private readonly bei: (z: Zustand) => void = () => {},
    private readonly optionen: SteuerungOptionen = {},
  ) {
    this.zustand.appModus = optionen.appModus ?? false;
  }

  private setze(teil: Partial<Zustand>): void {
    this.zustand = { ...this.zustand, ...teil };
    this.bei(this.zustand);
  }

  private fehler(e: unknown): void {
    const f = e instanceof ApiFehler ? e : new ApiFehler("UNBEKANNT", "", 0);
    if (this.optionen.appModus && (f.status === 401 || f.code === "GERAET_WIDERRUFEN")) {
      this.optionen.beiWiderruf?.();
      return;
    }
    this.setze({
      laedt: false,
      meldung: { art: "fehler", code: f.code, text: f.text, ...(f.korrelationsId ? { korrelationsId: f.korrelationsId } : {}) },
    });
  }

  async start(): Promise<void> {
    this.setze({ laedt: true });
    // Beschriftungen sind Komfort: fehlen sie, zeigt die Ansicht die Schlüssel, statt zu scheitern.
    // Die App-API kennt keine Einstellungen-Routen; dort kommen die Statusnamen aus der Liste selbst.
    const [b, s] = await Promise.all([this.api.beschriftungen().catch(() => ({})), this.optionen.appModus ? {} : this.api.statusNamen().catch(() => ({}))]);
    this.setze({ beschriftungen: b, statusNamen: s });
    await this.ladeListe();
  }

  async ladeListe(): Promise<void> {
    this.setze({ ansicht: "liste", laedt: true, meldung: null, detail: null });
    try {
      const liste = await this.api.liste(this.zustand.filter, this.zustand.seite);
      this.setze({ liste, laedt: false });
    } catch (e) {
      this.fehler(e);
    }
  }

  async zeigeEinstellungen(meldung: Meldung | null = null): Promise<void> {
    this.setze({ ansicht: "einstellungen", laedt: true, meldung, bearbeitung: null });
    try {
      const { eintraege } = await this.api.einstellungen();
      this.setze({ einstellungen: eintraege, laedt: false });
    } catch (e) {
      this.fehler(e);
    }
  }

  bearbeite(schluessel: string): void {
    const e = this.zustand.einstellungen?.find((x) => x.schluessel === schluessel);
    if (!e) return;
    this.setze({ bearbeitung: { schluessel, text: JSON.stringify(e.wert, null, 2), warnungen: [], vorschau: null }, meldung: null });
  }

  /** Tippen zeichnet nicht neu, sonst verliert das Textfeld den Fokus. */
  tippe(text: string): void {
    const b = this.zustand.bearbeitung;
    if (b) this.zustand = { ...this.zustand, bearbeitung: { ...b, text, vorschau: null } };
  }

  brichAb(): void {
    this.setze({ bearbeitung: null, meldung: null });
  }

  /**
   * Speichert mit der gesehenen Version. Plausibilitätswarnungen (A10) verlangen ein zweites,
   * bewusstes Speichern; derselbe Text wird dann ohne weitere Rückfrage gesendet.
   */
  async speichere(zuruecksetzen = false): Promise<void> {
    const b = this.zustand.bearbeitung;
    const eintrag = this.zustand.einstellungen?.find((x) => x.schluessel === b?.schluessel);
    if (!b || !eintrag || this.zustand.laedt) return;
    let wert: unknown = null;
    if (!zuruecksetzen) {
      try {
        wert = JSON.parse(b.text);
      } catch {
        this.setze({ meldung: { art: "fehler", code: "EINGABE_UNGUELTIG", text: this.zustand.beschriftungen.jsonUngueltig ?? "" } });
        return;
      }
      const warnungen = plausibilitaetsWarnungen(eintrag.schluessel as EinstellungsSchluessel, wert);
      if (warnungen.length && b.warnungen.join() !== warnungen.join()) {
        this.setze({ bearbeitung: { ...b, warnungen }, meldung: null });
        return;
      }
    }
    // Vorschau (A10): erst anzeigen, dann erst auf ein zweites Speichern hin schreiben. Zurücksetzen zeigt sie für den Standardwert.
    const vorschauText = zuruecksetzen ? "" : b.text;
    if (b.vorschau?.text !== vorschauText) {
      this.setze({ laedt: true, meldung: null });
      try {
        const ergebnis = await this.api.vorschau(eintrag.schluessel, wert);
        const jetzt = this.zustand.bearbeitung;
        this.setze({ laedt: false, bearbeitung: jetzt ? { ...jetzt, vorschau: { text: vorschauText, ergebnis } } : jetzt });
        // Gibt es nichts zu zeigen (keine Berichte oder Vorschau aus), ist ein zweiter Klick sinnlos.
        if (ergebnis.anzahl > 0) return;
      } catch (e) {
        this.fehler(e);
        return;
      }
    }
    this.setze({ laedt: true, meldung: null });
    try {
      await this.api.setzeEinstellung(eintrag.schluessel, wert, eintrag.version);
    } catch (e) {
      if (e instanceof ApiFehler && e.code === "VERSION_KONFLIKT") {
        await this.zeigeEinstellungen({ art: "konflikt", code: e.code, text: this.zustand.beschriftungen.konflikt ?? e.text });
        return;
      }
      this.fehler(e);
      return;
    }
    await this.zeigeEinstellungen();
  }

  async zeigeFehler(meldung: Meldung | null = null): Promise<void> {
    this.setze({ ansicht: "fehler", laedt: true, meldung });
    try {
      const fehlerListe = await this.api.fehlerListe(true);
      this.setze({ fehlerListe, laedt: false });
    } catch (e) {
      this.fehler(e);
    }
  }

  async quittiere(id: number): Promise<void> {
    if (this.zustand.laedt) return;
    this.setze({ laedt: true, meldung: null });
    try {
      await this.api.quittiere(id);
    } catch (e) {
      // Schon von jemand anderem quittiert: die Liste neu laden zeigt den wahren Stand.
      if (!(e instanceof ApiFehler && e.code === "NICHT_GEFUNDEN")) {
        this.fehler(e);
        return;
      }
    }
    await this.zeigeFehler();
  }

  async zeigeDeadLetter(meldung: Meldung | null = null): Promise<void> {
    this.setze({ ansicht: "deadletter", laedt: true, meldung });
    try {
      const deadLetter = await this.api.deadLetterListe();
      this.setze({ deadLetter, laedt: false });
    } catch (e) {
      this.fehler(e);
    }
  }

  /** Reiht einen Eintrag erneut ein; war er schon eingereiht (bereitsEingereiht), gibt es nur den Hinweis, die Liste zeigt den wahren Stand. */
  async reiheErneutEin(id: number): Promise<void> {
    if (this.zustand.laedt) return;
    this.setze({ laedt: true, meldung: null });
    let hinweis: Meldung | null = null;
    try {
      const r = await this.api.erneutEinreihen(id);
      if (r.bereitsEingereiht) hinweis = { art: "konflikt", text: this.zustand.beschriftungen.bereitsEingereiht ?? "" };
    } catch (e) {
      this.fehler(e);
      return;
    }
    await this.zeigeDeadLetter(hinweis);
  }

  async zeigeKennzahlen(): Promise<void> {
    this.setze({ ansicht: "kennzahlen", laedt: true, meldung: null });
    const { von, bis } = this.zustand.zeitraum;
    // Datumsangaben gelten als UTC-Tage; der Endtag gehört noch zum Zeitraum.
    const vonIso = von ? `${von}T00:00:00Z` : undefined;
    const bisIso = bis ? `${bis}T23:59:59Z` : undefined;
    try {
      const [kennzahlen, abweichungen] = await Promise.all([this.api.kennzahlen(vonIso, bisIso), this.api.abweichungen()]);
      this.setze({ kennzahlen, abweichungen, laedt: false });
    } catch (e) {
      this.fehler(e);
    }
  }

  async setzeZeitraum(von: string, bis: string): Promise<void> {
    this.zustand = { ...this.zustand, zeitraum: { von, bis } };
    await this.zeigeKennzahlen();
  }

  async setzeFilter(status: string | null): Promise<void> {
    this.zustand = { ...this.zustand, filter: status || null, seite: 1 };
    await this.ladeListe();
  }

  async geheZuSeite(seite: number): Promise<void> {
    const l = this.zustand.liste;
    const letzte = l ? Math.max(1, Math.ceil(l.gesamt / l.proSeite)) : 1;
    this.zustand = { ...this.zustand, seite: Math.min(Math.max(1, seite), letzte) };
    await this.ladeListe();
  }

  async oeffne(id: string, meldung: Meldung | null = null): Promise<void> {
    this.setze({ ansicht: "detail", laedt: true, meldung });
    try {
      const detail = await this.api.detail(id);
      this.setze({ detail, laedt: false });
    } catch (e) {
      this.fehler(e);
    }
  }

  /** Sendet die Aktion mit der Version, die der Admin gesehen hat. Bei VERSION_KONFLIKT wird neu geladen, nichts wird erneut gesendet. */
  async fuehreAus(aktion: string, notiz?: string, preisText?: string): Promise<void> {
    const d = this.zustand.detail;
    if (!d || this.zustand.laedt) return;
    this.setze({ laedt: true, meldung: null });
    try {
      // Der tatsächliche Preis (A11) gehört nur zum Ankauf; ob er brauchbar ist, entscheidet die API (ANKAUFSPREIS_UNGUELTIG).
      const preis = aktion === "ankauf_abschliessen" && preisText ? Number(preisText.trim().replace(",", ".")) : Number.NaN;
      await this.api.aktion(d.anfrage.id, aktion, d.anfrage.version, notiz, Number.isNaN(preis) ? undefined : preis);
    } catch (e) {
      if (e instanceof ApiFehler && e.code === "VERSION_KONFLIKT") {
        await this.oeffne(d.anfrage.id, { art: "konflikt", code: e.code, text: this.zustand.beschriftungen.konflikt ?? e.text });
        return;
      }
      this.fehler(e);
      return;
    }
    await this.oeffne(d.anfrage.id);
  }
}
