/**
 * Schleifenschutz für eingehende E-Mail: erkennt Autoreplies, Bounces und
 * Listenmails, damit das System nie auf automatische Post antwortet.
 * Reine Funktion über Kopfzeilen — kein I/O, keine fachlichen Zahlen.
 * Die Kopfzeilen-Namen und -Werte sind Protokollkonstanten (RFC 3834, 3464, 2919).
 */

export type Verwerfgrund =
  | "auto_submitted"
  | "x_autoreply"
  | "x_autorespond"
  | "precedence"
  | "list_id"
  | "leerer_rueckpfad"
  | "systemabsender"
  | "bounce_bericht"
  | "x_failed_recipients"
  | "eigene_adresse";

export type Schleifenurteil = { verwerfen: false } | { verwerfen: true; grund: Verwerfgrund; detail: string };

/** Minimal, was `Headers` und eine Map anbieten. */
export interface Kopfzeilen {
  get(name: string): string | null | undefined;
}

export interface SchleifenEingabe {
  kopfzeilen: Kopfzeilen;
  /** Absender der Hülle (SMTP MAIL FROM). Leer oder "<>" = Bounce. */
  umschlagAbsender?: string | undefined;
  /** Eigene Absenderadressen (Postfach, das wir bedienen). */
  eigeneAdressen?: readonly string[] | undefined;
}

const SYSTEM_LOKALTEILE = ["mailer-daemon", "postmaster"];
const MASSENPOST = ["bulk", "junk", "list", "auto_reply"];

/** Zerlegt Roh-Kopfzeilen (bis zur ersten Leerzeile), entfaltet Folgezeilen. */
export function leseKopfzeilen(rohtext: string): Kopfzeilen {
  const kopf = rohtext.replace(/\r\n/g, "\n").split("\n\n", 1)[0] ?? "";
  const werte = new Map<string, string>();
  let aktuell: string | null = null;
  for (const zeile of kopf.split("\n")) {
    if (/^[ \t]/.test(zeile) && aktuell) {
      werte.set(aktuell, `${werte.get(aktuell) ?? ""} ${zeile.trim()}`);
      continue;
    }
    const i = zeile.indexOf(":");
    if (i <= 0) {
      aktuell = null;
      continue;
    }
    const name = zeile.slice(0, i).trim().toLowerCase();
    aktuell = name;
    if (!werte.has(name)) werte.set(name, zeile.slice(i + 1).trim());
  }
  return { get: (name) => werte.get(name.toLowerCase()) ?? null };
}

/** Reine Adresse aus "Name <a@b>" oder "a@b (Kommentar)", kleingeschrieben. */
export function adresseVon(wert: string): string {
  const spitz = /<([^>]*)>/.exec(wert);
  const roh = spitz ? (spitz[1] ?? "") : wert;
  return (roh.trim().split(/\s/)[0] ?? "").toLowerCase();
}

function lokalteil(adresse: string): string {
  return adresse.split("@")[0] ?? "";
}

export function pruefeSchleifenschutz(eingabe: SchleifenEingabe): Schleifenurteil {
  const k = eingabe.kopfzeilen;
  const verwerfe = (grund: Verwerfgrund, detail: string): Schleifenurteil => ({ verwerfen: true, grund, detail });

  const auto = k.get("auto-submitted")?.trim().toLowerCase();
  if (auto && auto !== "no") return verwerfe("auto_submitted", auto);

  const autoreply = k.get("x-autoreply");
  if (autoreply != null) return verwerfe("x_autoreply", autoreply.trim());
  const autorespond = k.get("x-autorespond");
  if (autorespond != null) return verwerfe("x_autorespond", autorespond.trim());

  const vorrang = k.get("precedence")?.trim().toLowerCase();
  if (vorrang && MASSENPOST.includes(vorrang)) return verwerfe("precedence", vorrang);

  const listId = k.get("list-id");
  if (listId) return verwerfe("list_id", listId.trim());

  const huelle = eingabe.umschlagAbsender;
  if (huelle !== undefined && adresseVon(huelle) === "") return verwerfe("leerer_rueckpfad", "<>");
  const rueckpfad = k.get("return-path");
  if (rueckpfad != null && adresseVon(rueckpfad) === "") return verwerfe("leerer_rueckpfad", "<>");

  const absender = [k.get("from"), huelle].filter((w): w is string => !!w).map(adresseVon).filter((a) => a !== "");
  for (const adresse of absender) {
    if (SYSTEM_LOKALTEILE.includes(lokalteil(adresse))) return verwerfe("systemabsender", adresse);
  }

  const inhaltstyp = k.get("content-type")?.toLowerCase() ?? "";
  if (/multipart\/report|message\/delivery-status|report-type\s*=\s*"?delivery-status/.test(inhaltstyp)) {
    return verwerfe("bounce_bericht", (inhaltstyp.split(";")[0] ?? "").trim());
  }

  const fehlgeschlagen = k.get("x-failed-recipients");
  if (fehlgeschlagen) return verwerfe("x_failed_recipients", fehlgeschlagen.trim());

  const eigene = new Set((eingabe.eigeneAdressen ?? []).map((a) => a.trim().toLowerCase()));
  for (const adresse of absender) {
    if (eigene.has(adresse)) return verwerfe("eigene_adresse", adresse);
  }

  return { verwerfen: false };
}
