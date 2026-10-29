import { ApiFehler, type Api, type Beschriftungen, type Detail, type Liste } from "./api.js";

export interface Meldung {
  art: "konflikt" | "fehler";
  code?: string;
  text: string;
  korrelationsId?: string;
}

export interface Zustand {
  ansicht: "liste" | "detail";
  laedt: boolean;
  beschriftungen: Beschriftungen;
  statusNamen: Record<string, string>;
  filter: string | null;
  seite: number;
  liste: Liste | null;
  detail: Detail | null;
  meldung: Meldung | null;
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
