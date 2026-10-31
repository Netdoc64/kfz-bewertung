import { describe, expect, it } from "vitest";
import { EINSTELLUNGEN, EINSTELLUNGS_SCHLUESSEL, plausibilitaetsWarnungen } from "./einstellungen.js";
import { FEHLER, istFehlerCode } from "./fehler.js";

const NEUE_SCHLUESSEL = [
  "antwort.automatischErlaubt",
  "ablauf.autopilot",
  "ablauf.eskalation",
  "ablauf.nachholenNachMinuten",
  "ablauf.nachholenMaxJeLauf",
  "ankauf.maxGesamtAbschlagProzent",
  "ankauf.mindestPreisEuro",
  "ankauf.maxSpanneProzent",
  "eingang.maxJeAbsenderUndTag",
  "einstellungen.vorschauAnzahl",
  "benachrichtigung.kanal",
  "benachrichtigung.erinnerungNachStunden",
  "benachrichtigung.eskalationNachStunden",
  "benachrichtigung.texte",
  "betrieb.alarmKanal",
  "betrieb.alarmRuheMinuten",
  "betrieb.cronAufgaben",
  "betrieb.deadLetterAlarmAb",
  "bericht.vorlagen",
  "mail.absenderAdresse",
  "mail.eingangsAdresse",
  "mail.eigeneAdressen",
  "mail.adminEmpfaenger",
  "quelle.referenzAbgleichStunden",
];

describe("Autonomie-Schlüssel", () => {
  it.each(EINSTELLUNGS_SCHLUESSEL)("Standardwert von %s passt zum Schema und hat Gruppe und Beschreibung", (k) => {
    const d = EINSTELLUNGEN[k];
    expect(d.schema.safeParse(d.standard).success).toBe(true);
    expect(d.gruppe.length).toBeGreaterThan(0);
    expect(d.beschreibung.length).toBeGreaterThan(10);
  });

  it.each(NEUE_SCHLUESSEL)("%s ist in der Registry", (k) => {
    expect(EINSTELLUNGS_SCHLUESSEL as string[]).toContain(k);
  });

  it("neue Gruppe eingang", () => {
    expect(EINSTELLUNGEN["eingang.maxJeAbsenderUndTag"].gruppe).toBe("eingang");
  });

  it("Autopilot kennt nur an, nur_verarbeiten, aus", () => {
    const s = EINSTELLUNGEN["ablauf.autopilot"].schema;
    expect(s.safeParse("nur_verarbeiten").success).toBe(true);
    expect(s.safeParse("pause").success).toBe(false);
  });

  it("automatisch erlaubt sind nur Anlässe ohne Preis", () => {
    const s = EINSTELLUNGEN["antwort.automatischErlaubt"].schema;
    expect(s.safeParse(["angebot"]).success).toBe(false);
    expect(s.safeParse(["eingang"]).success).toBe(true);
  });

  it("Vorlage datenschutz und Hinweis kein Gutachten sind im Standard", () => {
    expect(EINSTELLUNGEN["antwort.vorlagen"].standard.de?.datenschutz).toBeTruthy();
    for (const v of Object.values(EINSTELLUNGEN["bericht.vorlagen"].standard)) {
      expect(v.hinweis).toMatch(/kein Gutachten/);
      expect(v.html).toContain("{{hinweis}}");
    }
  });

  it("Mailadressen: leer erlaubt, Unsinn nicht", () => {
    const s = EINSTELLUNGEN["mail.absenderAdresse"].schema;
    expect(s.safeParse("").success).toBe(true);
    expect(s.safeParse("a@b.de").success).toBe(true);
    expect(s.safeParse("kein-mail").success).toBe(false);
  });
});

describe("Plausibilitätswarnungen", () => {
  it("warnen über dem Bereich, ohne das Schema zu verletzen", () => {
    const k = "ankauf.maxSpanneProzent";
    expect(EINSTELLUNGEN[k].schema.safeParse(80).success).toBe(true);
    expect(plausibilitaetsWarnungen(k, 80)).toHaveLength(1);
  });

  it("schweigen im Bereich und ohne Grenzen", () => {
    expect(plausibilitaetsWarnungen("ankauf.maxSpanneProzent", 20)).toEqual([]);
    expect(plausibilitaetsWarnungen("bewertung.mindestVergleiche", 9999)).toEqual([]);
    expect(plausibilitaetsWarnungen("ablauf.autopilot", "an")).toEqual([]);
  });

  it("Standardwerte lösen keine Warnung aus", () => {
    for (const k of EINSTELLUNGS_SCHLUESSEL) expect(plausibilitaetsWarnungen(k, EINSTELLUNGEN[k].standard), k).toEqual([]);
  });
});

describe("Fehlercodes für Phase 1–3", () => {
  const CODES = [
    "AUTOPILOT_GESPERRT",
    "FREIGABE_FEHLT",
    "VERSAND_FEHLGESCHLAGEN",
    "ZU_VIELE_ANFRAGEN",
    "PLAUSIBILITAET_VERLETZT",
    "JOB_VERALTET",
    "BERICHT_FEHLT",
    "BERICHT_VORLAGE_FEHLT",
    "MAIL_UNGUELTIG",
    "MAIL_SCHLEIFE",
    "CRON_FEHLGESCHLAGEN",
    "ALARM_FEHLGESCHLAGEN",
    "DEAD_LETTER",
    "KI_ABGELEHNT",
    "KI_ZEITUEBERSCHREITUNG",
    "KI_ANTWORT_UNGUELTIG",
    "KI_BUDGET_ERSCHOEPFT",
    "KOPPLUNGSCODE_UNGUELTIG",
    "GERAET_WIDERRUFEN",
    "PUSH_FEHLGESCHLAGEN",
  ];

  it.each(CODES)("%s steht vollständig im Katalog", (c) => {
    expect(istFehlerCode(c)).toBe(true);
    const f = FEHLER[c as keyof typeof FEHLER];
    expect(f.text.length).toBeGreaterThan(10);
    expect(typeof f.wiederholbar).toBe("boolean");
    expect(f.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Schlüssel für Phase 6 und 7", () => {
  const GRUPPEN: Record<string, string> = {
    "ki.modell": "ki",
    "ki.aufwand": "ki",
    "ki.maxAusgabeToken": "ki",
    "ki.zeitlimitMs": "ki",
    "ki.mindestSicherheit": "ki",
    "ki.preiseJeMillionToken": "ki",
    "app.tokenLaufzeitTage": "app",
    "app.kopplungscodeGueltigMinuten": "app",
    "push.aktiv": "push",
    "push.texte": "push",
  };

  it.each(Object.entries(GRUPPEN))("%s ist in Gruppe %s angelegt, Standard gültig", (k, g) => {
    const d = EINSTELLUNGEN[k as keyof typeof EINSTELLUNGEN];
    expect(d.gruppe).toBe(g);
    expect(d.beschreibung.length).toBeGreaterThan(10);
    expect(d.schema.safeParse(d.standard).success).toBe(true);
  });

  it("ki.mindestSicherheit lehnt Werte über 1 ab, ki.aufwand unbekannte Stufen", () => {
    expect(EINSTELLUNGEN["ki.mindestSicherheit"].schema.safeParse(1.5).success).toBe(false);
    expect(EINSTELLUNGEN["ki.aufwand"].schema.safeParse("maximal").success).toBe(false);
  });

  it("push.aktiv ist standardmäßig aus", () => {
    expect(EINSTELLUNGEN["push.aktiv"].standard).toBe(false);
  });
});

describe("zod 4: gespeicherte Werte bleiben gültig", () => {
  it("jeder Standardwert besteht sein eigenes Schema", () => {
    for (const k of EINSTELLUNGS_SCHLUESSEL) {
      const d = EINSTELLUNGEN[k];
      expect(d.schema.safeParse(d.standard).success, k).toBe(true);
    }
  });

  it("übliche Mailadressen und die leere Adresse bleiben gültig", () => {
    const s = EINSTELLUNGEN["mail.adminEmpfaenger"].schema;
    expect(s.safeParse(["ankauf@beispiel.de", "a.b+c@sub.beispiel.de"]).success).toBe(true);
    expect(s.safeParse(["kein-at"]).success).toBe(false);
  });
});
