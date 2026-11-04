export interface Befund {
  stufe: "fehler" | "warnung" | "ok";
  text: string;
}
export interface Optionen {
  fetch?: typeof fetch;
  zeitlimitMs?: number;
}
export function rauchtest(url: string | undefined, optionen?: Optionen): Promise<{ ok: boolean; befunde: Befund[] }>;
