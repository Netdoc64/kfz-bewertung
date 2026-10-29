/** Ausgehender Kanal (E-Mail, WhatsApp, …). Die Wahl und der Versand selbst liegen im Adapter. */
export interface AusgehendeNachricht {
  an: string;
  text: string;
  korrelation: string;
}

export interface Kanal {
  /** Name, wie er in `nachrichten.kanal` steht. */
  readonly name: string;
  /** Wirft bei Fehlern; der Port macht daraus VERSAND_FEHLGESCHLAGEN. */
  sende(nachricht: AusgehendeNachricht): Promise<{ externeId?: string }>;
}

/** Test-Kanal: merkt sich alles, sendet nichts. */
export class MockKanal implements Kanal {
  readonly gesendet: AusgehendeNachricht[] = [];
  fehler: Error | null = null;

  constructor(readonly name = "mock") {}

  async sende(nachricht: AusgehendeNachricht): Promise<{ externeId?: string }> {
    if (this.fehler) throw this.fehler;
    this.gesendet.push(nachricht);
    return { externeId: `mock-${this.gesendet.length}` };
  }
}
