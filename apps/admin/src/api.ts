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
    liste(status: string | null, seite: number): Promise<Liste> {
      const q = new URLSearchParams({ seite: String(seite) });
      if (status) q.set("status", status);
      return rufe<Liste>(`/anfragen?${q}`);
    },
    detail: (id: string): Promise<Detail> => rufe<Detail>(`/anfragen/${encodeURIComponent(id)}`),
    aktion: (id: string, aktion: string, version: number, notiz?: string): Promise<{ version: number }> =>
      rufe(`/anfragen/${encodeURIComponent(id)}/aktion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aktion, version, ...(notiz ? { notiz } : {}) }),
      }),
  };
}
export type Api = ReturnType<typeof erzeugeApi>;
