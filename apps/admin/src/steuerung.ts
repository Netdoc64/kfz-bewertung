import { plausibilitaetsWarnungen, type EinstellungsSchluessel } from "@kfz/shared";
import { ApiFehler, type Api, type Beschriftungen, type Detail, type EinstellungsEintrag, type FehlerEintrag, type Liste, type Vorschau } from "./api.js";

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
  ansicht: "liste" | "detail" | "einstellungen" | "fehler";
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
  };

  constructor(
    private readonly api: Api,
    private readonly bei: (z: Zustand) => void = () => {},
  ) {}

  private setze(teil: Partial<Zustand>): void {
    this.zustand = { ...this.zustand, ...teil };
    this.bei(this.zustand);
  }

  private fehler(e: unknown): void {
    const f = e instanceof ApiFehler ? e : new ApiFehler("UNBEKANNT", "", 0);
    this.setze({
      laedt: false,
      meldung: { art: "fehler", code: f.code, text: f.text, ...(f.korrelationsId ? { korrelationsId: f.korrelationsId } : {}) },
    });
  }

  async start(): Promise<void> {
    this.setze({ laedt: true });
    // Beschriftungen sind Komfort: fehlen sie, zeigt die Ansicht die Schlüssel, statt zu scheitern.
    const [b, s] = await Promise.all([this.api.beschriftungen().catch(() => ({})), this.api.statusNamen().catch(() => ({}))]);
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
  async fuehreAus(aktion: string, notiz?: string): Promise<void> {
    const d = this.zustand.detail;
    if (!d || this.zustand.laedt) return;
    this.setze({ laedt: true, meldung: null });
    try {
      await this.api.aktion(d.anfrage.id, aktion, d.anfrage.version, notiz);
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
