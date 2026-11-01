/** Enter und Leertaste lösen auf einem fokussierten Nicht-Knopf (Tabellenzeile) aus wie ein Klick. */
export function istAktivierung(e: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
  return (e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.altKey && !e.metaKey;
}
