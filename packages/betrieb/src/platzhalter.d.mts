export function parseJsonc(text: string): unknown;
export function pruefe(konfig: unknown, umgebung?: string): string[];
export function pruefeText(text: string, umgebung?: string): string[];
export function lauf(
  argv: string[],
  ausgabe?: { aus: (z: string) => void; fehler: (z: string) => void },
): number;
