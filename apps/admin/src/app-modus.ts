import { ApiFehler, erzeugeApi, type Abruf, type Api } from "./api.js";

/** Was der Gerätespeicher von der Kopplung hält: Adresse der API und Geräte-Token. */
export interface Kopplung {
  adresse: string;
  token: string;
}

export type Speicher = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const SCHLUESSEL = "kfz.kopplung";
const BESCHRIFTUNGEN = "kfz.kopplung.beschriftungen";

/** Capacitor setzt `window.Capacitor`; ohne Access-Umgebung des Admin-Webs läuft die App so. */
export const istAppModus = (fenster: { Capacitor?: unknown } | undefined): boolean => Boolean(fenster && fenster.Capacitor);

const standardSpeicher = (): Speicher | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function ladeKopplung(speicher: Speicher | null = standardSpeicher()): Kopplung | null {
  try {
    const roh = speicher?.getItem(SCHLUESSEL);
    if (!roh) return null;
    const k = JSON.parse(roh) as Partial<Kopplung>;
    return typeof k.adresse === "string" && typeof k.token === "string" && k.adresse && k.token ? { adresse: k.adresse, token: k.token } : null;
  } catch {
    return null;
  }
}

export function loescheKopplung(speicher: Speicher | null = standardSpeicher()): void {
  try {
    speicher?.removeItem(SCHLUESSEL);
  } catch {
    // Ohne Gerätespeicher bleibt nur die Sitzung; die Ansicht wechselt trotzdem.
  }
}

/** Beschriftungen überleben das Löschen der Kopplung, damit die Kopplungsansicht ohne API lesbar bleibt. */
export function merkeBeschriftungen(b: Record<string, string>, speicher: Speicher | null = standardSpeicher()): void {
  try {
    if (Object.keys(b).length) speicher?.setItem(BESCHRIFTUNGEN, JSON.stringify(b));
  } catch {
    // Komfort, kein Muss.
  }
}

export function ladeBeschriftungen(speicher: Speicher | null = standardSpeicher()): Record<string, string> {
  try {
    const roh = speicher?.getItem(BESCHRIFTUNGEN);
    return roh ? (JSON.parse(roh) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Entfernt Leerraum und Schrägstriche am Ende; nur http(s) ist eine Adresse. */
export function normalisiereAdresse(eingabe: string): string | null {
  const a = eingabe.trim().replace(/\/+$/, "");
  try {
    const u = new URL(a);
    return u.protocol === "http:" || u.protocol === "https:" ? a : null;
  } catch {
    return null;
  }
}

/** Tauscht den Kopplungscode gegen ein Geräte-Token und speichert Adresse und Token im Gerätespeicher. */
export async function koppeln(abruf: Abruf, eingabe: { adresse: string; code: string; name: string }, speicher: Speicher | null = standardSpeicher()): Promise<Kopplung> {
  const adresse = normalisiereAdresse(eingabe.adresse);
  if (!adresse) throw new ApiFehler("EINGABE_UNGUELTIG", "", 0);
  let antwort: Response;
  try {
    antwort = await abruf(`${adresse}/api/app/koppeln`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: eingabe.code.trim(), name: eingabe.name.trim() }),
    });
  } catch {
    throw new ApiFehler("NETZ", "", 0);
  }
  const koerper = (await antwort.json().catch(() => null)) as { token?: string; fehler?: { code: string; text: string; korrelationsId?: string } } | null;
  if (!antwort.ok || !koerper?.token) {
    const f = koerper?.fehler;
    throw new ApiFehler(f?.code ?? "UNBEKANNT", f?.text ?? "", antwort.status, f?.korrelationsId);
  }
  const kopplung = { adresse, token: koerper.token };
  try {
    speicher?.setItem(SCHLUESSEL, JSON.stringify(kopplung));
  } catch {
    // Das Token gilt dann nur bis zum Schließen der App.
  }
  return kopplung;
}

/** API auf `<adresse>/api/app` mit dem Geräte-Token; Liste und Detail liegen dort an der Wurzel. */
export function erzeugeAppApi(abruf: Abruf, k: Kopplung): Api {
  return erzeugeApi(abruf, `${k.adresse}/api/app`, { token: () => k.token, anfragen: "", gemeinsameBeschriftungen: true });
}
