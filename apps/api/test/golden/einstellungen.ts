import type { AnkaufRegel } from "@kfz/shared";
import type { BewertungsEinstellungen } from "../../src/bewertung/bewerten.js";

/**
 * Fest verdrahtete Einstellungen für die goldenen Fälle. Absichtlich NICHT aus den
 * Registry-Standards abgeleitet: eine Änderung der Standards darf diese Erwartungen nicht kippen.
 */
export const REGEL_HOHE_KM: AnkaufRegel = {
  id: "hohe-km",
  bezeichnung: "Hohe Laufleistung",
  aktiv: true,
  bedingungen: [{ feld: "kilometer", op: "groesser", wert: 150000 }],
  wirkung: { art: "prozent", wert: 4 },
  begruendung: "Laufleistung über 150.000 km",
};

export const REGEL_OHNE_HEFT: AnkaufRegel = {
  id: "ohne-heft",
  bezeichnung: "Kein Scheckheft angegeben",
  aktiv: true,
  bedingungen: [{ feld: "scheckheft", op: "fehlt" }],
  wirkung: { art: "betrag", wert: 100 },
  begruendung: "Scheckheft nicht belegt",
};

export const GOLDEN_EINSTELLUNGEN: BewertungsEinstellungen = {
  "bewertung.mindestVergleiche": 5,
  "bewertung.zielVergleiche": 10,
  "bewertung.suchStufen": [
    { ezToleranzJahre: 0, kmToleranzProzent: 15, umkreisKm: 200, leistungToleranzProzent: 5 },
    { ezToleranzJahre: 1, kmToleranzProzent: 25, umkreisKm: 500, leistungToleranzProzent: 10 },
    { ezToleranzJahre: 2, kmToleranzProzent: 40, umkreisKm: null, leistungToleranzProzent: 15 },
  ],
  "bewertung.ausreisserIqrFaktor": 1.5,
  "bewertung.mindestPreisEuro": 500,
  "bewertung.ausschlussBegriffe": ["export", "unfallwagen"],
  "bewertung.angebotsAbschlagProzent": 5,
  "bewertung.kmKorrekturProzentJe10000": 2.5,
  "bewertung.alterKorrekturProzentJeJahr": 8,
  "bewertung.konfidenzStreuungGrenzeProzent": 15,
  "bewertung.rundungEuro": 50,
  "ankauf.margeProzent": 12,
  "ankauf.aufbereitungPauschaleEuro": 400,
  "ankauf.standkostenEuroJeTag": 15,
  "ankauf.erwarteteStandtage": 30,
  "ankauf.spanneProzent": 5,
  "ankauf.maxGesamtAbschlagProzent": 30,
  "ankauf.mindestPreisEuro": 300,
  "ankauf.maxSpanneProzent": 25,
  "ankauf.regeln": [REGEL_HOHE_KM, REGEL_OHNE_HEFT],
  "ablauf.eskalation": { konfidenzMin: 0.5, maxAnkaufEuro: 30000, ausgeschlosseneKlassen: ["oldtimer", "nutzfahrzeug"], sonstigesAnMensch: true },
};
