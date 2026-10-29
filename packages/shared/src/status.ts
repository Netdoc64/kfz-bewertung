/**
 * Statusmaschine einer Anfrage. Die Übergänge sind Invarianten und stehen
 * deshalb im Code; Anzeigenamen kommen aus `ablauf.statusBeschriftungen`.
 */

export const STATUS = [
  "eingegangen",
  "unvollstaendig",
  "in_bewertung",
  "zur_freigabe",
  "nachbearbeiten",
  "freigegeben",
  "angebot_versendet",
  "verhandlung",
  "besichtigung",
  "angekauft",
  "abgesagt",
  "abgelehnt",
  "an_mensch",
  "fehlgeschlagen",
] as const;

export type Status = (typeof STATUS)[number];

/** Wer einen Übergang auslösen darf. */
export type Ausloeser = "system" | "admin";

export interface Aktion {
  name: string;
  von: readonly Status[];
  nach: Status;
  durch: Ausloeser;
}

const AKTIV: readonly Status[] = [
  "eingegangen",
  "unvollstaendig",
  "in_bewertung",
  "zur_freigabe",
  "nachbearbeiten",
  "freigegeben",
  "angebot_versendet",
  "verhandlung",
  "besichtigung",
  "fehlgeschlagen",
];

export const AKTIONEN = [
  // System
  { name: "angaben_fehlen", von: ["eingegangen"], nach: "unvollstaendig", durch: "system" },
  { name: "angaben_ergaenzt", von: ["unvollstaendig"], nach: "eingegangen", durch: "system" },
  { name: "bewertung_starten", von: ["eingegangen", "nachbearbeiten", "fehlgeschlagen"], nach: "in_bewertung", durch: "system" },
  { name: "bewertung_fertig", von: ["in_bewertung"], nach: "zur_freigabe", durch: "system" },
  { name: "fehlschlag", von: ["in_bewertung"], nach: "fehlgeschlagen", durch: "system" },
  { name: "uebergeben", von: AKTIV, nach: "an_mensch", durch: "system" },

  // Admin — Freigabe
  { name: "freigeben", von: ["zur_freigabe"], nach: "freigegeben", durch: "admin" },
  { name: "ablehnen", von: ["zur_freigabe"], nach: "abgelehnt", durch: "admin" },
  { name: "nachbearbeiten", von: ["zur_freigabe", "fehlgeschlagen", "an_mensch"], nach: "nachbearbeiten", durch: "admin" },

  // Admin — weitere Abwicklung
  { name: "angebot_senden", von: ["freigegeben"], nach: "angebot_versendet", durch: "admin" },
  { name: "verhandeln", von: ["angebot_versendet", "besichtigung"], nach: "verhandlung", durch: "admin" },
  { name: "gegenangebot_senden", von: ["verhandlung"], nach: "angebot_versendet", durch: "admin" },
  { name: "besichtigung_planen", von: ["freigegeben", "angebot_versendet", "verhandlung"], nach: "besichtigung", durch: "admin" },
  { name: "ankauf_abschliessen", von: ["angebot_versendet", "verhandlung", "besichtigung"], nach: "angekauft", durch: "admin" },
  { name: "absagen", von: AKTIV, nach: "abgesagt", durch: "admin" },
  { name: "uebernehmen", von: AKTIV, nach: "an_mensch", durch: "admin" },
] as const satisfies readonly Aktion[];

export type AktionsName = (typeof AKTIONEN)[number]["name"];

export const ENDSTATUS: readonly Status[] = ["angekauft", "abgesagt", "abgelehnt"];

export function moeglicheAktionen(status: Status, durch?: Ausloeser): Aktion[] {
  return (AKTIONEN as readonly Aktion[]).filter((a) => a.von.includes(status) && (durch === undefined || a.durch === durch));
}

/** Liefert den Zielstatus oder null, wenn die Aktion hier nicht erlaubt ist. */
export function uebergang(status: Status, aktion: string, durch: Ausloeser): Status | null {
  const a = (AKTIONEN as readonly Aktion[]).find((x) => x.name === aktion);
  if (!a || a.durch !== durch || !a.von.includes(status)) return null;
  return a.nach;
}
