import type { Status } from "@kfz/shared";

export interface Fahrzeug {
  marke?: string;
  modell?: string;
  [feld: string]: unknown;
}

export interface Anfrage {
  id: string;
  kanal: string;
  status: Status;
  statusText: string;
  version: number;
  kunde_name: string | null;
  kunde_kontakt: string | null;
  fahrzeug: Fahrzeug;
  erstellt_am: string;
  geaendert_am: string;
}

export interface Liste {
  eintraege: Anfrage[];
  seite: number;
  proSeite: number;
  gesamt: number;
}

export interface Aktion {
  name: string;
  nach: Status;
  nachText: string;
}

export interface Ereignis {
  id: number;
  aktion: string;
  status_von: string | null;
  status_nach: string;
  statusNachText: string;
  durch: string;
  notiz: string | null;
  am: string;
}

export interface Nachricht {
  id: string;
  kanal: string;
  anlass: string;
  inhalt: string;
  status: string;
  erstellt_am: string;
}

export interface KundenNachricht {
  id: number;
  kanal: string;
  text: string;
  erstellt_am: string;
}

export interface Bericht {
  generation: number;
  gueltigBis: string;
  html: string;
}

export interface Detail {
  anfrage: Anfrage;
  ereignisse: Ereignis[];
  nachrichten: Nachricht[];
  kundenNachrichten: KundenNachricht[];
  bericht: Bericht | null;
  aktionen: Aktion[];
}

export interface EinstellungsEintrag {
  schluessel: string;
  wert: unknown;
  standard: unknown;
  version: number;
  quelle: string;
  gruppe: string;
  beschreibung: string;
  geaendertAm: string | null;
  geaendertVon: string | null;
}

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
  ankaufDifferenzEuro: number | null;
  geaendert: boolean;
}

export interface Vorschau {
  schluessel: string;
  anzahl: number;
  geaendert: number;
  zeilen: VorschauZeile[];
}

export interface FehlerEintrag {
  id: number;
  code: string;
  schwere: string;
  ort: string;
  nachricht: string;
  letzteKorrelation: string;
  anzahl: number;
  erstmals: string;
  zuletzt: string;
  quittiertAm: string | null;
}

export interface DeadLetterEintrag {
  id: number;
  nachricht_id: string;
  queue: string;
  anfrage_id: string | null;
  job_generation: number | null;
  korrelation: string | null;
  nutzlast: unknown;
  versuche: number;
  erstellt_am: string;
  erneut_am: string | null;
  erneut_von: string | null;
  erneut_generation: number | null;
  /** Nur in der Antwort von POST :id/erneut. */
  bereitsEingereiht?: boolean;
}

export interface Dauer {
  anzahl: number;
  /** Sekunden */
  mittel: number | null;
  median: number | null;
  max: number | null;
}

export interface Kennzahlen {
  zeitraum: { von: string; bis: string };
  anfragen: number;
  durchlaufzeit: Record<string, Dauer | number | undefined>;
  anMensch: { anzahl: number; anteil: number | null; mitGrund: number; anteilMitGrund: number | null; gruende: Record<string, number> };
  konfidenz: { berichte: number; mittel: number | null; klassen: { von: number | null; bis: number | null; anzahl: number }[] };
  fehlerrate: { bewertungen: number; fehlgeschlagen: number; rate: number | null };
  freigabedauer: Dauer;
}

export interface AbweichungsZeile {
  marke: string;
  segment: string;
  anzahl: number;
  abweichungEuro: number;
  abweichungProzent: number;
  belastbar: boolean;
}

export interface Abweichungen {
  gesamt: number;
  ohneSchaetzung: number;
  zeilen: AbweichungsZeile[];
}

export type Beschriftungen = Record<string, string>;

/** Fehler der API im Format des Fehlerkatalogs. */
export class ApiFehler extends Error {
  constructor(
    readonly code: string,
    readonly text: string,
    readonly status: number,
    readonly korrelationsId?: string,
  ) {
    super(text);
  }
}

export type Abruf = (url: string, init?: RequestInit) => Promise<Response>;

export function erzeugeApi(abruf: Abruf, basis = "/api/admin") {
  async function rufe<T>(pfad: string, init?: RequestInit): Promise<T> {
    let antwort: Response;
    try {
      antwort = await abruf(`${basis}${pfad}`, init);
    } catch {
      throw new ApiFehler("NETZ", "", 0);
    }
    const koerper = (await antwort.json().catch(() => null)) as { fehler?: { code: string; text: string; korrelationsId?: string } } | null;
    if (!antwort.ok) {
      const f = koerper?.fehler;
      throw new ApiFehler(f?.code ?? "UNBEKANNT", f?.text ?? "", antwort.status, f?.korrelationsId);
    }
    return koerper as T;
  }

  return {
    beschriftungen: async (): Promise<Beschriftungen> => (await rufe<{ wert: Beschriftungen }>("/einstellungen/oberflaeche.beschriftungen")).wert,
    statusNamen: async (): Promise<Record<string, string>> => (await rufe<{ wert: Record<string, string> }>("/einstellungen/ablauf.statusBeschriftungen")).wert,
    einstellungen: (): Promise<{ abdruck: string; eintraege: EinstellungsEintrag[] }> => rufe("/einstellungen"),
    setzeEinstellung: (schluessel: string, wert: unknown, version: number): Promise<EinstellungsEintrag> =>
      rufe(`/einstellungen/${encodeURIComponent(schluessel)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wert, version }),
      }),
    vorschau: (schluessel: string, wert: unknown): Promise<Vorschau> =>
      rufe(`/einstellungen/${encodeURIComponent(schluessel)}/vorschau`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wert }),
      }),
    fehlerListe: async (offen: boolean): Promise<FehlerEintrag[]> => (await rufe<{ fehler: FehlerEintrag[] }>(`/fehler?offen=${offen ? "ja" : "alle"}`)).fehler,
    quittiere: (id: number): Promise<{ ok: true }> => rufe(`/fehler/${id}/quittieren`, { method: "POST" }),
    liste(status: string | null, seite: number): Promise<Liste> {
      const q = new URLSearchParams({ seite: String(seite) });
      if (status) q.set("status", status);
      return rufe<Liste>(`/anfragen?${q}`);
    },
    detail: (id: string): Promise<Detail> => rufe<Detail>(`/anfragen/${encodeURIComponent(id)}`),
    deadLetterListe: async (alle = false): Promise<DeadLetterEintrag[]> => (await rufe<{ eintraege: DeadLetterEintrag[] }>(`/dead-letter${alle ? "?alle=1" : ""}`)).eintraege,
    erneutEinreihen: (id: number): Promise<DeadLetterEintrag> => rufe(`/dead-letter/${id}/erneut`, { method: "POST" }),
    kennzahlen(von?: string, bis?: string): Promise<Kennzahlen> {
      const q = new URLSearchParams();
      if (von) q.set("von", von);
      if (bis) q.set("bis", bis);
      const s = q.toString();
      return rufe<Kennzahlen>(`/kennzahlen${s ? `?${s}` : ""}`);
    },
    abweichungen: (): Promise<Abweichungen> => rufe("/anfragen/auswertung/ankaeufe"),
    aktion: (id: string, aktion: string, version: number, notiz?: string, ankaufspreisEuro?: number): Promise<{ version: number }> =>
      rufe(`/anfragen/${encodeURIComponent(id)}/aktion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aktion, version, ...(notiz ? { notiz } : {}), ...(ankaufspreisEuro !== undefined ? { ankaufspreisEuro } : {}) }),
      }),
  };
}
export type Api = ReturnType<typeof erzeugeApi>;
